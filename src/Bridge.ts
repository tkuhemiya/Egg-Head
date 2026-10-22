/**
 * Text-mode loop: utterance in, decision record out. Every decision is kept for the dashboard.
 *
 * hear(): ask Decider once per utterance -> route -> run the check -> compare in code ->
 *         ledger -> gate -> maybe speak. Silence ticks reuse the gate without a new utterance.
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
import { type BridgeAnswers, buildQuestions, POLICY, renderState, type Turn } from "./Questions.ts"
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

export interface BridgeState {
  readonly turns: ReadonlyArray<Turn>
  readonly ledger: L.Ledger
  readonly events: ReadonlyArray<Event>
  readonly escalations: number
  readonly lastSpokeS: number // Clock seconds; -Infinity until Egg Head first speaks
  readonly answers: Option.Option<BridgeAnswers> // last Decider batch, reused by silence ticks
}

const initial: BridgeState = {
  turns: [],
  ledger: L.empty,
  events: [],
  escalations: 0,
  lastSpokeS: -Infinity,
  answers: Option.none()
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
      const policy = Option.filter(s.answers, (a) => POLICY.every((q) => a[q] !== undefined))
      const [selfRepairedP, interruptP] = Option.match(policy, {
        onNone: () => [0.0, 0.5], // claim was just added this turn; policy questions were not asked yet
        onSome: (a) => [a.self_repaired!.probability, a.floor_free!.probability]
      })
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
        const resources = yield* source.resources
        const [elapsed, { answers }] = yield* Effect.timed(
          decider.decide(buildQuestions(resources, openItems.length > 0), { input: renderState(window, openItems) })
        )
        let s: BridgeState = { ...heard, answers: Option.some(answers) }
        let ev: Event = {
          ...blankEvent(heard.turns.length - 1, speaker, text),
          deciderMs: Duration.toMillis(elapsed)
        }

        let rt = route(answers)
        ev = { ...ev, route: Option.some(rt) }
        if (rt.action === "escalate") {
          s = { ...s, escalations: s.escalations + 1 }
          ev = { ...ev, escalations: s.escalations }
          if (Option.isSome(escalator)) {
            rt = yield* escalator.value.route(window)
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
