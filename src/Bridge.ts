/**
 * Bridge: the shell. Owns the Ref, the pubsub, the hear lane and the interpreter; decides nothing.
 */
import { Clock, Context, Duration, Effect, Layer, Option, PubSub, Ref, Schema, Scope, Semaphore, Stream } from "effect"
import { type AiError, DecisionModel } from "effect/ai"
import * as Claims from "./Claims.ts"
import { CheckSource } from "./Checks.ts"
import type { Request } from "./Conversation.ts"
import { blankEvent, type Event as Ev } from "./Event.ts"
import * as Gather from "./Gather.ts"
import { Judgments } from "./Judgments.ts"
import { jobNumber, type SpeechId } from "./Ids.ts"
import { direct, Investigator } from "./Investigator.ts"
import type { Ledger } from "./Ledger.ts"
import type { Turn } from "./Questions.ts"
import { aliasHits, Escalator } from "./Router.ts"
import { type SupportError, templateLine, Writer } from "./Speaker.ts"
import * as Requests from "./Requests.ts"
import { direct as policyDirect, empty as emptyState, investigated, type Policy, type State } from "./State.ts"
import type { Command, Transition } from "./State.ts"
import type { Outcome } from "./Jobs.ts"
import { pending as pendingOf, reduce } from "./Step.ts"
import { Tuning } from "./Tuning.ts"

export * from "./Event.ts"
export { WINDOW_TURNS } from "./State.ts"

export const Verdict = Schema.Literals(["supports", "contradicts", "inconclusive"])
export type Verdict = typeof Verdict.Type

export const CallInput = Schema.Union([
  Schema.TaggedStruct("Utterance", { speaker: Schema.String, text: Schema.String, silenceS: Schema.Number }),
  Schema.TaggedStruct("Silence", { silenceS: Schema.Number })
])
export type CallInput = typeof CallInput.Type

export interface GateSignals {
  readonly selfRepairedP: number
  readonly interruptP: number
}

export interface BridgeState {
  readonly turns: ReadonlyArray<Turn>
  readonly ledger: Ledger
  readonly events: ReadonlyArray<Ev>
  readonly escalations: number
  readonly lastSpokeS: number
  readonly gateSignals: Option.Option<GateSignals>
  readonly requests: ReadonlyArray<Request>
  readonly tasks: number
  readonly finishedP: number
  readonly notes: ReadonlyArray<string>
}

const projectState = (s: State, agentMode: boolean): BridgeState => ({
  turns: s.turns,
  ledger: s.claims.map((c) => Claims.toLedgerItem(c, agentMode)),
  events: s.events,
  escalations: s.escalations,
  lastSpokeS: Option.getOrElse(s.floor.lastUnpromptedAt, () => Option.getOrElse(s.floor.lastEndedAt, () => Number.NEGATIVE_INFINITY)),
  gateSignals: Option.some({ selfRepairedP: s.selfRepairedP, interruptP: s.interruptP }),
  requests: s.requests.map(Requests.toPublic),
  tasks: Math.max(0, s.jobs.next - 1),
  finishedP: s.finishedP,
  notes: s.notes
})

export type BridgeError = AiError.AiError | SupportError

export class Bridge extends Context.Service<Bridge, {
  hear(speaker: string, text: string, silenceS?: number): Effect.Effect<Ev, BridgeError>
  tick(silenceS: number): Effect.Effect<Option.Option<Ev>, SupportError>
  partial(speaker: string, text: string): Effect.Effect<Option.Option<Ev>, BridgeError>
  spoke(id: SpeechId, how?: "finished" | "dropped"): Effect.Effect<void>
  run<E, R>(inputs: Stream.Stream<CallInput, E, R>): Stream.Stream<Ev, E | BridgeError, R>
  readonly state: Effect.Effect<BridgeState>
  readonly pending: Effect.Effect<number>
  readonly changes: Stream.Stream<Ev>
}>()("egghead/Bridge") {
  static readonly make = Effect.gen(function*() {
    const source = yield* CheckSource
    const writer = yield* Writer
    const escalator = yield* Effect.serviceOption(Escalator)
    const investigator = yield* Effect.serviceOption(Investigator)
    const decider = yield* DecisionModel.DecisionModel
    const tuning = yield* Tuning
    const judgments = yield* Judgments
    const scope = yield* Scope.Scope
    const policy: Policy = Option.isSome(investigator) ? investigated : policyDirect
    const epoch = String(yield* Clock.currentTimeMillis)
    const state = yield* Ref.make(emptyState(epoch))
    const hearLane = yield* Semaphore.make(1)
    const pubsub = yield* PubSub.unbounded<Ev>()
    const nowS = Effect.map(Clock.currentTimeMillis, (ms) => ms / 1000)
    const deps: Gather.Deps = {
      decider,
      source,
      escalator: Option.getOrUndefined(escalator),
      judgments,
      tuning,
      policy
    }

    const transact = (input: Parameters<typeof reduce>[1]) =>
      Effect.uninterruptible(Effect.gen(function*() {
        const now = yield* nowS
        const t = yield* Ref.modify(state, (s) => {
          const next = reduce(s, input, { now, tuning, policy })
          return [next, next.state]
        })
        const held = t.state.floor.phase._tag === "Composing" && Option.isSome(t.event) &&
          t.state.events[t.state.events.length - 1] !== t.event.value
        if (Option.isSome(t.event) && !held) yield* PubSub.publish(pubsub, t.event.value)
        return t
      }))

    const runJob = (cmd: Command) => {
      if (cmd._tag !== "StartJob") return Effect.void
      const { job, payload } = cmd
      const inv = job.via === "investigator" && Option.isSome(investigator) ? investigator.value : direct(source)
      const task = jobNumber(job.id)
      const body: Effect.Effect<Outcome> = payload.kind === "answer"
        ? inv.answer(task, payload.question).pipe(
          Effect.map((text): Outcome => ({ _tag: "Reported", report: { _tag: "Answered", text, by: inv.name } })),
          Effect.catch((e: SupportError): Effect.Effect<Outcome> =>
            Effect.succeed(
              String(e.cause).includes("no resource")
                ? { _tag: "Reported", report: { _tag: "Unknown", why: "no resource named in the question", by: inv.name } }
                : { _tag: "Failed", reason: String(e.cause) }
            )
          )
        )
        : inv.confirm(task, Claims.toLedgerItem(payload.claim, true)).pipe(
          Effect.map((f): Outcome =>
            f.status === "unknown"
              ? { _tag: "Reported", report: { _tag: "Unknown", why: f.fact.slice(0, 240), by: f.by } }
              : { _tag: "Reported", report: { _tag: "Checked", status: f.status, fact: f.fact.slice(0, 240), by: f.by } }
          ),
          Effect.catch((e: SupportError): Effect.Effect<Outcome> => Effect.succeed({ _tag: "Failed", reason: String(e.cause) }))
        )
      const seconds = Math.max(0.05, job.deadlineAt - job.startedAt)
      return body.pipe(
        Effect.timeoutOption(Duration.seconds(seconds)),
        Effect.flatMap((opt) => transact({ _tag: "JobDone", id: job.id, outcome: Option.match(opt, { onNone: () => ({ _tag: "TimedOut" as const }), onSome: (o) => o }) })),
        Effect.flatMap((t) => interpret(t)),
        Effect.catchCause(Effect.logError),
        Effect.forkIn(scope),
        Effect.asVoid
      )
    }

    const interpret = (t: Transition): Effect.Effect<Ev, SupportError> =>
      Effect.gen(function*() {
        let current = t
        for (const cmd of t.commands) {
          if (cmd._tag === "StartJob") yield* runJob(cmd)
          if (cmd._tag === "Compose") {
            const item = Claims.toLedgerItem(cmd.claim, policy.secondLook)
            const text = yield* writer.write(item).pipe(Effect.catch(() => Effect.succeed(templateLine(item))))
            current = yield* transact({ _tag: "Composed", id: cmd.id, text: Option.some(text) })
          }
        }
        return Option.getOrElse(current.event, () => Option.getOrElse(t.event, () => blankEvent(0, "", "")))
      })

    const hear = (speaker: string, text: string, silenceS = 0) =>
      hearLane.withPermits(1)(Effect.gen(function*() {
        yield* transact({ _tag: "LineBegan", speaker, text, silenceS })
        const snap = yield* Ref.get(state)
        const turn = snap.turns.length - 1
        const gathered = yield* Gather.line(snap, turn, silenceS, deps).pipe(
          Effect.map((evidence) => ({ ok: true as const, evidence })),
          Effect.catch((e: BridgeError) => Effect.succeed({ ok: false as const, e }))
        )
        const t = yield* transact(
          gathered.ok
            ? { _tag: "LineUnderstood", turn, silenceS, evidence: gathered.evidence }
            : { _tag: "LineFailed", turn, reason: String(gathered.e) }
        )
        const event = yield* interpret(t)
        if (!gathered.ok) return yield* Effect.fail(gathered.e)
        return event
      }))

    const tick = (silenceS: number) =>
      Effect.gen(function*() {
        const t = yield* transact({ _tag: "Silence", silenceS })
        if (Option.isNone(t.event) && t.commands.length === 0) return Option.none<Ev>()
        const event = yield* interpret(t)
        return Option.some(event)
      })

    const partial = (speaker: string, text: string) =>
      Effect.gen(function*() {
        if (!policy.barge) return Option.none<Ev>()
        const snap = yield* Ref.get(state)
        const named = new Set(aliasHits(text))
        const item = snap.claims.find((c) => named.has(c.resource) && Claims.bargeable(c))
        if (item === undefined) return Option.none<Ev>()
        const key = `${snap.turns.length}|${item.id}`
        const words = text.split(/\s+/).length
        const last = snap.partials[key]
        if (last !== undefined && words < last + 2) return Option.none<Ev>()
        yield* Ref.update(state, (s) => ({ ...s, partials: { ...s.partials, [key]: words } }))
        const evidence = yield* Gather.partial(snap, item.id, speaker, text, deps)
        const t = yield* transact({ _tag: "PartialHeard", speaker, text, claim: item.id, evidence })
        if (Option.isNone(t.event) && t.commands.length === 0) return Option.none<Ev>()
        return Option.some(yield* interpret(t))
      })

    const spoke = (id: SpeechId, how: "finished" | "dropped" = "finished") =>
      transact({ _tag: "SpeechEnded", id, how }).pipe(Effect.asVoid)

    const run = <E, R>(inputs: Stream.Stream<CallInput, E, R>) =>
      inputs.pipe(
        Stream.mapEffect((input) =>
          input._tag === "Utterance"
            ? Effect.map(hear(input.speaker, input.text, input.silenceS), (ev) => [ev])
            : Effect.map(tick(input.silenceS), Option.toArray)
        ),
        Stream.flattenIterable
      )

    return Bridge.of({
      hear,
      tick,
      partial,
      spoke,
      run,
      state: Effect.map(Ref.get(state), (s) => projectState(s, policy.secondLook)),
      pending: Effect.map(Ref.get(state), pendingOf),
      changes: Stream.fromPubSub(pubsub)
    })
  })

  static readonly layer = Layer.effect(Bridge, Bridge.make)
}
