/**
 * Bridge: the shell around Core. Same four verbs as today (hear, tick, partial, run), one new
 * one (finished), none of them able to fail, and no lock around state.
 *
 *   state     one SubscriptionRef<Core.State>. Every input is one `modify` with Core.reduce:
 *             the commit, the event log and the published change are the same write (finding 11).
 *   slow      a step that needs Decider, the check or the Writer returns `then`; the shell runs
 *             it with nothing held and applies the result as the next input. Ticks, partials,
 *             job results and `finished` never wait behind a slow call (review Consider #2).
 *   hears     go through one FIFO (Queue + one fiber): turns are appended in arrival order and
 *             analysed one at a time, so Heard(n) always applies before Heard(n+1) (gotcha 19).
 *             Only hears wait on each other. W7 can analyse several lines at once and still apply
 *             them in order, because Observe reads a snapshot and Core applies Heard by turn.
 *   jobs      the runner fiber reads committed state: Queued -> JobStarted (commit) -> fork the
 *             work with Effect.timeout(deadline - now) -> JobDone. Core also expires jobs on every
 *             input, so the state ends even if a fiber hangs (findings 4, 9).
 *   changes   events with seq > n, read from state: a late subscriber can replay (gotcha 26).
 *
 * Errors: Observe and Writer failures become inputs (Heard{Failed}; a failed write falls back to
 * the template line), so `hear`, `tick` and `partial` have `never` in the error channel and the
 * call loop's ticker cannot die of one bad call (finding 8).
 */
import { Context, Effect, Layer, Option, Stream } from "effect"
import type { State } from "./Core.ts"
import type { CallInput, Event, UtteranceId } from "./Event.ts" // CallInput: today's Schema, moved beside Event unchanged

/** What the call loop reads to hold the humans: Egg Head is writing or speaking. */
export type SpeechView = { readonly _tag: "Quiet" } | { readonly _tag: "Writing" } | { readonly _tag: "Speaking"; readonly id: UtteranceId }

export class Bridge extends Context.Service<Bridge, {
  /** A final transcript segment. Resolves with this turn's one event (after any flag it triggered is written). */
  hear(speaker: string, text: string, silenceS?: number): Effect.Effect<Event>
  /** More silence (VAD). No Decider call; may say a line, may wait for the Writer. */
  tick(silenceS: number): Effect.Effect<Option.Option<Event>>
  /** Words of a line still being spoken. Some(event with said.kind "barge") when Egg Head cuts in. */
  partial(speaker: string, text: string): Effect.Effect<Option.Option<Event>>
  /** Egg Head's clip for this utterance ended, or it could not be voiced. Idempotent. */
  finished(utterance: UtteranceId): Effect.Effect<void>
  run<E, R>(inputs: Stream.Stream<CallInput, E, R>): Stream.Stream<Event, E, R>
  readonly state: Effect.Effect<State>
  readonly speech: Effect.Effect<SpeechView>
  /** Work Egg Head owes the call: jobs, answers and updates to say, lines being analysed or spoken. */
  readonly pending: Effect.Effect<number>
  /** Every event from `fromSeq` (default: from now), in order. */
  changes(fromSeq?: number): Stream.Stream<Event>
}>()("egghead/Bridge") {
  /**
   * Needs DecisionModel, CheckSource, Writer; optional Escalator, Investigator, Reading (default
   * Reading.rules), Tuning. Mode = Option.isSome(investigator) ? Core.AGENT : Core.PLAIN, read once.
   */
  static readonly make = Effect.gen(function*() {
    throw new Error("not implemented")
    // const ref = yield* SubscriptionRef.make(Core.initial)
    // const apply = (input) => Effect.flatMap(Clock.currentTimeMillis, (ms) =>
    //   SubscriptionRef.modify(ref, (s) => { const step = Core.reduce(s, input, ms / 1000, mode, tuning);
    //     const ev = Option.map(step.event, (e) => ({ ...e, seq: s.events.length }));
    //     return [[ev, step.then], { ...step.state, events: Option.match(ev, { onNone: () => step.state.events, onSome: (e) => [...step.state.events, e] }) }] }))
    // const drive = (input): Effect<Option<Event>> =>          // apply, then follow `then` until none
    //   apply(input).pipe(Effect.flatMap(([ev, then]) => Option.match(then, {
    //     onNone: () => Effect.succeed(ev),
    //     onSome: (t) => Effect.flatMap(slow(t), drive) })))   // slow(): Observe | AskAct | Write, never fails
    // hear    = offer to the ingest queue, await its Deferred (the queue fiber runs drive(Utterance))
    // tick    = drive(Silence)
    // partial = drive(Partial)
    // finished= apply(Finished)
    // runner  = SubscriptionRef.changes(ref) -> Jobs.queued -> apply(JobStarted) -> forkIn(scope)(work.timeout -> apply(JobDone))
  })

  static readonly layer = Layer.effect(Bridge, Bridge.make)
}
