/**
 * Bridge: the shell. Owns the Ref, the pubsub, the hear lane and the interpreter; decides nothing.
 *
 * Concurrency (separate-before-serializing):
 *  - NO lock around state. `transact` is one `Ref.modify` of the pure `reduce`; microseconds.
 *  - `hear` calls are the only things serialized (the hear lane, Semaphore(1)), because line n+1's
 *    meaning depends on n. The lane is held across gather (Decider, check, Bedrock escalation);
 *    tick, partial, job results, speech reports never wait for it.
 *  - Slow work for a speech (writer) runs after the decision commit, outside every lock; the
 *    originator (hear/tick/partial) awaits ITS OWN compose, nobody else does.
 *  - W7 (latency) can move gather for line n+1 under line n's compose by relaxing the lane to
 *    "ordered commit, parallel gather": Evidence is id-keyed and reduce is idempotent, so it only
 *    needs the lane's critical section shrunk. Not built now.
 */
import { Context, Effect, Layer, Option, Stream } from "effect"
import type { AiError } from "effect/ai"
import type { Event } from "./Event.ts"
import type { SpeechId } from "./Ids.ts"
import type { SupportError } from "./Speaker.ts"
import type { Command, State, Transition } from "./State.ts"

export type BridgeError = AiError.AiError | SupportError

/** What the call feeds the Bridge (unchanged). */
export type CallInput =
  | { readonly _tag: "Utterance"; readonly speaker: string; readonly text: string; readonly silenceS: number }
  | { readonly _tag: "Silence"; readonly silenceS: number }

export class Bridge extends Context.Service<Bridge, {
  /** A finished line. Always ends in one Event for its turn, even if understanding failed (then the error is re-raised after the commit). */
  hear(speaker: string, text: string, silenceS?: number): Effect.Effect<Event, BridgeError>
  tick(silenceS: number): Effect.Effect<Option.Option<Event>, SupportError>
  partial(speaker: string, text: string): Effect.Effect<Option.Option<Event>, BridgeError>
  /**
   * NEW. The caller tells the Bridge when Egg Head's line (Event.speech.id) stopped playing, or never will
   * ("dropped": voicing failed). The Bridge cannot know clip length. Idempotent; unknown ids are ignored.
   */
  spoke(id: SpeechId, how?: "finished" | "dropped"): Effect.Effect<void>
  run<E, R>(inputs: Stream.Stream<CallInput, E, R>): Stream.Stream<Event, E | BridgeError, R>
  readonly state: Effect.Effect<State>
  /** Work still owed to the call: running jobs, Standing claims, owed retractions, live requests. */
  readonly pending: Effect.Effect<number>
  readonly changes: Stream.Stream<Event>
}>()("egghead/Bridge") {
  static readonly make: Effect.Effect<never, never, never> = Effect.sync(() => { throw new Error("not implemented") })
  static readonly layer: Layer.Layer<Bridge> = Layer.empty as never
}

/*
 --- shell internals (pseudocode) ---------------------------------------------------------------

 // The only way state changes. Uninterruptible, so state and the published event cannot part (finding 11).
 const transact = (input: Input): Effect<Committed> =>
   Effect.uninterruptible(Effect.gen(function*() {
     const now = yield* nowS
     const t: Transition = yield* Ref.modify(stateRef, (s) => { const t = reduce(s, input, { now, tuning, policy }); return [t, t.state] })
     if (Option.isSome(t.event) && !composing(t)) yield* PubSub.publish(pubsub, t.event.value)
     return new Committed(t)            // class with a private constructor: commands exist only after commit
   }))

 // Interpreting commands. StartJob is forked into the Bridge scope AFTER commit (finding 4: a failed hear
 // can no longer leave a job whose record was never written). Every job body is total:
 const runJob = (job: Job, payload): Effect<void> =>
   investigatorFor(job.via).run(payload).pipe(                       // Investigator.confirm/answer, or direct
     Effect.timeoutOrElse({ duration: deadlineIn(job), orElse: () => Effect.succeed(TimedOut) }),
     Effect.map(Reported), Effect.catch((e) => Effect.succeed(Failed(String(e)))),
     Effect.onInterrupt(() => deliver(Cancelled)),
     Effect.flatMap(deliver))                                          // deliver = transact(JobDone) + interpret; idempotent
 // A second fiber sleeps to job.deadlineAt and transacts Sweep, so a wedged runJob is still retired.

 const hear = (speaker, text, silenceS = 0) => hearLane.withPermits(1)(Effect.gen(function*() {
   const began = yield* transact(LineBegan)                           // turn allocated, analysing++
   const snapshot = yield* Ref.get(stateRef)
   const ev = yield* Gather.line(snapshot, turn, deps).pipe(Effect.exit)
   const understood = ev succeeded ? LineUnderstood{evidence} : LineFailed{reason}   // analysing-- either way, even on interrupt (Effect.onInterrupt)
   const c = yield* transact(understood)
   const event = yield* interpret(c)                                  // forks jobs; awaits OWN Compose then transact(Composed); returns the published event
   if (failed) return yield* Effect.fail(error)
   return event
 }))

 const partial = (speaker, text) => Effect.gen(function*() {
   const reserved = yield* Ref.modify(stateRef, reservePartial)       // pure: picks the bargeable claim named by aliasHits, applies the "ask again only with 2 more words" rule IN STATE
   if (none) return Option.none()
   const evidence = yield* Gather.partial(...)                        // Decider act + corrects, no lock
   return yield* settle(PartialHeard{...})
 })
*/
export declare class Committed { private constructor(); readonly transition: Transition; readonly commands: ReadonlyArray<Command> }
