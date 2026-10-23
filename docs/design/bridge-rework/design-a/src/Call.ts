/**
 * THE CALLER'S VIEW. Excerpts of src/Call.ts (session) as it changes. Everything else in the loop is untouched.
 */
import { Clock, Effect, Option, Stream } from "effect"
import { Bridge } from "./Bridge.ts"
import type { Event } from "./Event.ts"

declare const bridge: Bridge["Service"]
declare const publish: (m: unknown) => Effect.Effect<void>
declare const sound: { speak(voice: string, text: string): Effect.Effect<{ audio: string; durationS: number; marks: unknown }> }
declare const voiceOf: (name: string) => string

// 1. Every decision arrives on `changes`. When Egg Head speaks, voice it and TELL THE BRIDGE when it ends.
const onEvent = (ev: Event) =>
  Effect.gen(function*() {
    yield* publish({ type: "event", event: ev })
    if (Option.isNone(ev.speech)) return
    const speech = ev.speech.value
    const clip = yield* sound.speak(voiceOf("Egg Head"), speech.text).pipe(
      Effect.tapError(() => bridge.spoke(speech.id, "dropped")) // voicing failed: the Bridge reopens the floor
    )
    yield* publish({ type: "egghead", text: speech.text, durationS: clip.durationS, kind: speech.kind, certainty: speech.certainty })
    // the clip's end is the caller's knowledge. Live: the page/ASR says so; offline: the sound's duration.
    yield* Effect.sleep(`${Math.round(clip.durationS * 1000)} millis`).pipe(
      Effect.andThen(bridge.spoke(speech.id, "finished")),
      Effect.forkScoped
    )
  })

// 2. The silence ticker survives errors (finding 8) and no longer needs to know whether Egg Head is talking:
//    the Bridge discounts its own speech (Floor.silence).
const ticker = (lastEnd: () => Effect.Effect<number>) =>
  Effect.forever(Effect.gen(function*() {
    yield* Effect.sleep("250 millis")
    const end = yield* lastEnd()
    const t = (yield* Clock.currentTimeMillis) / 1000
    if (Number.isFinite(end) && t - end >= 0.5) yield* bridge.tick(t - end)
  }).pipe(Effect.catchCause((c) => Effect.logError(c))))

// 3. Barge-in is unchanged for the loop: partial returns Some(event) with speech.kind === "barge" -> cut the line.
//    Without an Investigator `partial` is always None.
export { onEvent, ticker }
void Stream
