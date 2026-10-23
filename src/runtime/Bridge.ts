/**
 * Bridge: the shell. Owns the Ref, the pubsub and the hear lane; decides nothing.
 * Slow work is Gather. The only write is Step.reduce inside transact. Commands run in Interpret.
 */
import { Clock, Context, Effect, Layer, Option, PubSub, Ref, Schema, Scope, Semaphore, Stream } from "effect"
import { type AiError, DecisionModel } from "effect/ai"
import * as Claims from "../domain/Claims.ts"
import { CheckSource } from "../domain/Checks.ts"
import type { Request } from "../domain/Conversation.ts"
import { type Event as Ev } from "../domain/Event.ts"
import * as Gather from "./Gather.ts"
import { interpret } from "./Interpret.ts"
import { Judgments } from "../domain/Judgments.ts"
import { type SpeechId } from "../domain/Ids.ts"
import { Investigator } from "./Investigator.ts"
import type { Ledger } from "../domain/Ledger.ts"
import type { Turn } from "../domain/Questions.ts"
import { aliasHits, Escalator } from "../domain/Router.ts"
import { type SupportError, Writer } from "../domain/Speaker.ts"
import * as Requests from "../domain/Requests.ts"
import { direct as policyDirect, empty as emptyState, investigated, type Policy, type State } from "../domain/State.ts"
import { pending as pendingOf, reduce } from "../domain/Step.ts"
import { Tuning } from "../domain/Tuning.ts"

export * from "../domain/Event.ts"
export { WINDOW_TURNS } from "../domain/State.ts"

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

    const apply = interpret({ transact, writer, source, investigator, policy, scope })

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
        const event = yield* apply(t)
        if (!gathered.ok) return yield* Effect.fail(gathered.e)
        return event
      }))

    const tick = (silenceS: number) =>
      Effect.gen(function*() {
        const t = yield* transact({ _tag: "Silence", silenceS })
        if (Option.isNone(t.event) && t.commands.length === 0) return Option.none<Ev>()
        const event = yield* apply(t)
        return Option.some(event)
      })

    const partial = (speaker: string, text: string) =>
      Effect.gen(function*() {
        if (!policy.barge) return Option.none<Ev>()
        const snap = yield* Ref.get(state)
        if (snap.floor.phase._tag !== "Open") return Option.none<Ev>()
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
        return Option.some(yield* apply(t))
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
