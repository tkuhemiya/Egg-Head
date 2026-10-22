/**
 * Text-mode loop: utterance in, decision record out. Every decision is kept for the dashboard.
 *
 * hear(): route the latest utterance (Router.ts; Decider) and, while a claim is open, ask the
 *         gate questions in parallel -> run the check -> compare in code -> ledger -> gate ->
 *         maybe speak. Silence ticks reuse the last gate answers without a new utterance.
 *
 * All call state lives in one Ref and is only touched while holding the Bridge's semaphore,
 * so `hear` and `tick` never interleave. `run` turns a stream of call inputs (transcript
 * segments and VAD silence) into the stream of decisions; `changes` broadcasts them.
 */
import { Clock, Context, Duration, Effect, Layer, Option, PubSub, Ref, Schema, Semaphore, Stream } from "effect"
import { type AiError, DecisionModel } from "effect/ai"
import { CheckSource } from "./Checks.ts"
import { compare, inferAsserted } from "./Compare.ts"
import * as G from "./Gate.ts"
import * as L from "./Ledger.ts"
import { finishedProbability, gateQuestions, renderGate, type Turn } from "./Questions.ts"
import { Escalator, Route, route } from "./Router.ts"
import { type SupportError, Writer } from "./Speaker.ts"

export const WINDOW_TURNS = 12 // rolling window; the model context is 4,096 tokens

export const Verdict = Schema.Literals(["supports", "contradicts", "inconclusive"])

export const Event = Schema.Struct({
  turn: Schema.Int,
  speaker: Schema.String,
  text: Schema.String,
  deciderMs: Schema.Number,
  route: Schema.OptionFromNullOr(Route),
  verdict: Schema.OptionFromNullOr(Verdict),
  checkEvidence: Schema.OptionFromNullOr(Schema.String),
  gate: Schema.OptionFromNullOr(G.GateDecision),
  /** Gate questions asked with this utterance: self_repaired, finished (Platt) and finished_raw. */
  gateScores: Schema.Record(Schema.String, Schema.Number),
  said: Schema.OptionFromNullOr(Schema.String),
  escalations: Schema.Int
})
export type Event = typeof Event.Type

/** What the call feeds the Bridge: a final transcript segment, or more silence from VAD. */
export const CallInput = Schema.Union([
  Schema.TaggedStruct("Utterance", { speaker: Schema.String, text: Schema.String, silenceS: Schema.Number }),
  Schema.TaggedStruct("Silence", { silenceS: Schema.Number })
])
export type CallInput = typeof CallInput.Type

/** The last gate answers, reused by silence ticks. */
export interface GateSignals {
  readonly selfRepairedP: number
  readonly interruptP: number // 1 - P(finished), Platt-scaled
}

export interface BridgeState {
  readonly turns: ReadonlyArray<Turn>
  readonly ledger: L.Ledger
  readonly events: ReadonlyArray<Event>
  readonly escalations: number
  readonly lastSpokeS: number // Clock seconds; -Infinity until Egg Head first speaks
  readonly gateSignals: Option.Option<GateSignals>
}

const initial: BridgeState = {
  turns: [],
  ledger: L.empty,
  events: [],
  escalations: 0,
  lastSpokeS: -Infinity,
  gateSignals: Option.none()
}

const blankEvent = (turn: number, speaker: string, text: string): Event => ({
  turn,
  speaker,
  text,
  deciderMs: 0,
  route: Option.none(),
  verdict: Option.none(),
  checkEvidence: Option.none(),
  gate: Option.none(),
  gateScores: {},
  said: Option.none(),
  escalations: 0
})

export type BridgeError = AiError.AiError | SupportError

export class Bridge extends Context.Service<Bridge, {
  hear(speaker: string, text: string, silenceS?: number): Effect.Effect<Event, BridgeError>
  /** More silence with no new utterance (from VAD). Re-runs the gate on the last answers. */
  tick(silenceS: number): Effect.Effect<Option.Option<Event>, SupportError>
  run<E, R>(inputs: Stream.Stream<CallInput, E, R>): Stream.Stream<Event, E | BridgeError, R>
  readonly state: Effect.Effect<BridgeState>
  /** Every decision from now on, for the dashboard. */
  readonly changes: Stream.Stream<Event>
}>()("egghead/Bridge") {
  static readonly make = Effect.gen(function*() {
    const source = yield* CheckSource
    const writer = yield* Writer
    const escalator = yield* Effect.serviceOption(Escalator)
    const decider = yield* DecisionModel.DecisionModel
    const state = yield* Ref.make(initial)
    const lock = yield* Semaphore.make(1)
    const pubsub = yield* PubSub.unbounded<Event>()

    /** Gate the oldest open claim and speak if it opens. Returns the new state and event. */
    const decide = Effect.fnUntraced(function*(s: BridgeState, ev: Event, silenceS: number, supportsOpen: boolean) {
      const item = L.open(s.ledger)[0]
      if (item === undefined) return [s, ev] as const
      const { selfRepairedP, interruptP } = Option.getOrElse(s.gateSignals, () => ({
        selfRepairedP: 0.0, // claim was just added this turn; the gate questions were not asked yet
        interruptP: 0.5
      }))
      const nowS = (yield* Clock.currentTimeMillis) / 1000
      const gate = G.decide({
        check: item.check,
        status: item.status,
        laterTurns: s.turns.slice(item.turn + 1).map(([, text]) => text),
        silenceS,
        selfRepairedP,
        interruptP,
        laterClaimSupportsCheck: supportsOpen,
        secondsSinceLastSpoke: nowS - s.lastSpokeS
      })
      const decided = { ...ev, gate: Option.some(gate) }
      if (gate.speak) {
        const said = yield* writer.write(item)
        return [
          { ...s, ledger: L.markRaised(s.ledger, item), lastSpokeS: nowS },
          { ...decided, said: Option.some(said) }
        ] as const
      }
      if (Option.isSome(gate.repairedBy)) {
        // corrected by the call itself: close it, stay silent
        return [{ ...s, ledger: L.markRaised(s.ledger, item) }, decided] as const
      }
      return [s, decided] as const
    })

    const commit = (s: BridgeState, ev: Event) =>
      Ref.set(state, { ...s, events: [...s.events, ev] }).pipe(Effect.andThen(PubSub.publish(pubsub, ev)), Effect.as(ev))

    const hear = (speaker: string, text: string, silenceS = 0) =>
      lock.withPermits(1)(Effect.gen(function*() {
        const heard = yield* Ref.updateAndGet(state, (s) => ({ ...s, turns: [...s.turns, [speaker, text] as const] }))
        const window = heard.turns.slice(-WINDOW_TURNS)
        const openItems = L.open(heard.ledger)
        const inventory = yield* source.inventory
        const askGate = Effect.map(
          decider.decide(gateQuestions, { input: renderGate(window, silenceS, openItems) }),
          ({ answers }) => answers
        )
        const [elapsed, [routed, gateAnswers]] = yield* Effect.timed(Effect.all([
          route(window, inventory).pipe(Effect.provideService(DecisionModel.DecisionModel, decider)),
          openItems.length > 0 ? Effect.asSome(askGate) : Effect.succeedNone
        ], { concurrency: "unbounded" }))
        const finished = Option.map(gateAnswers, (a) => finishedProbability(a.fin.probability))
        let s: BridgeState = Option.isSome(gateAnswers) && Option.isSome(finished)
          ? { ...heard, gateSignals: Option.some({ selfRepairedP: gateAnswers.value.rep.probability, interruptP: 1 - finished.value }) }
          : heard
        let ev: Event = {
          ...blankEvent(heard.turns.length - 1, speaker, text),
          deciderMs: Duration.toMillis(elapsed),
          gateScores: Option.match(gateAnswers, {
            onNone: () => ({}),
            onSome: (a) => ({ self_repaired: a.rep.probability, finished: finished.pipe(Option.getOrElse(() => 0)), finished_raw: a.fin.probability })
          })
        }

        let rt = routed
        ev = { ...ev, route: Option.some(rt) }
        if (rt.action === "escalate") {
          s = { ...s, escalations: s.escalations + 1 }
          ev = { ...ev, escalations: s.escalations }
          if (Option.isSome(escalator)) {
            const decided = rt
            rt = yield* escalator.value.route(window)
            rt = { ...rt, scores: { ...decided.scores, ...rt.scores } } // keep Decider's scores beside the escalator's
            ev = { ...ev, route: Option.some(rt) }
          }
        }

        let supportsOpen = false
        if (rt.action === "check" && Option.isSome(rt.check) && Option.isSome(rt.resource)) {
          const [check, resource] = [rt.check.value, rt.resource.value]
          const res = yield* source.run(check, resource)
          if (Option.isSome(res)) {
            const asserted = Option.getOrNull(rt.asserted)
            const verdict = compare(asserted === "unclear" ? inferAsserted(text) : asserted, res.value.status)
            ev = { ...ev, verdict: Option.some(verdict), checkEvidence: Option.some(res.value.evidence) }
            if (verdict === "contradicts") {
              s = {
                ...s,
                ledger: L.add(s.ledger, {
                  speaker,
                  claim: text,
                  check,
                  resource,
                  status: res.value.status,
                  evidence: res.value.evidence,
                  turn: ev.turn,
                  raised: false
                })
              }
            } else if (verdict === "supports") {
              supportsOpen = openItems.some((i) => i.check === check && i.resource === resource)
            }
          }
        }
        const [next, decided] = yield* decide(s, ev, silenceS, supportsOpen)
        return yield* commit(next, decided)
      }))

    const tick = (silenceS: number) =>
      lock.withPermits(1)(Effect.gen(function*() {
        const s = yield* Ref.get(state)
        if (L.open(s.ledger).length === 0 || s.events.length === 0) return Option.none<Event>()
        const [next, decided] = yield* decide(s, blankEvent(s.turns.length - 1, "(silence)", ""), silenceS, false)
        return Option.some(yield* commit(next, decided))
      }))

    const run = <E, R>(inputs: Stream.Stream<CallInput, E, R>) =>
      inputs.pipe(
        Stream.mapEffect((input) =>
          input._tag === "Utterance"
            ? Effect.map(hear(input.speaker, input.text, input.silenceS), (ev) => [ev])
            : Effect.map(tick(input.silenceS), Option.toArray) // a tick with nothing open emits nothing
        ),
        Stream.flattenIterable
      )

    return Bridge.of({ hear, tick, run, state: Ref.get(state), changes: Stream.fromPubSub(pubsub) })
  })

  /** Needs a DecisionModel (Decider.ts), a CheckSource and a Writer; Escalator is optional. */
  static readonly layer = Layer.effect(Bridge, Bridge.make)
}
