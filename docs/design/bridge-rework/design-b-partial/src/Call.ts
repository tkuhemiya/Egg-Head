/**
 * Call (delta): the loop as a caller of the new Bridge. Only the changed parts are shown.
 *
 * What changes for the loop:
 * - It tells the Bridge when Egg Head's clip ends: `bridge.finished(said.id)`. That is the only
 *   new duty. The Bridge then knows Egg Head is speaking, and owns the gap rule.
 * - The humans hold while `bridge.speech` is not Quiet (plus a 0.6 s pad), instead of the loop's
 *   own `humansWaitUntil` guesses (+30 s while voicing, clip + 0.6 s after). Floor and
 *   Floor.holdWhileWriting are deleted: "Egg Head is writing" is Speech.Writing.
 * - The ticker needs no catch: tick's error channel is `never`.
 * - A barge cuts the line from the `changes` stream, not from partial's return value, so an
 *   interrupted partial fiber cannot lose a barge that was committed (finding 11).
 * - Events say which line they belong to (`turn`), and turns are appended in hear's call order,
 *   so `lineOfTurn` stays aligned (gotchas 18, 19).
 */
import { Effect, Option, Ref, Stream } from "effect"
import { Bridge } from "./Bridge.ts"
import type { Event } from "./Event.ts"

declare const sound: { speak(voice: string, text: string): Effect.Effect<{ readonly durationS: number; readonly audio: string }> }
declare const publish: (m: unknown) => Effect.Effect<void>
declare const indexOf: (ev: Event) => Effect.Effect<number>
declare const cutCurrentLine: (text: string) => Effect.Effect<void>

export const sessionSketch = Effect.gen(function*() {
  const bridge = yield* Bridge

  // Every Bridge decision is published; when Egg Head speaks, voice it and say when it ended.
  const onEvent = (ev: Event) =>
    Effect.gen(function*() {
      const index = yield* indexOf(ev)
      yield* publish({ type: "event", index, event: ev })
      if (Option.isNone(ev.said)) return
      const said = ev.said.value
      if (said.kind === "barge") yield* cutCurrentLine(ev.text)
      const clip = yield* sound.speak("Matthew", said.text).pipe(Effect.option)
      if (Option.isNone(clip)) return yield* bridge.finished(said.id) // could not voice it: not speaking
      yield* publish({ type: "egghead", index, text: said.text, audio: clip.value.audio, durationS: clip.value.durationS, kind: said.kind })
      yield* Effect.sleep(`${Math.round(clip.value.durationS * 1000)} millis`)
      yield* bridge.finished(said.id)
    }).pipe(Effect.forkScoped) // one fiber per line; the Bridge never lets two lines overlap
  yield* bridge.changes(0).pipe(Stream.runForEach(onEvent), Effect.forkScoped) // from seq 0: no subscribe race

  // Humans wait while Egg Head writes or talks.
  const holdForEggHead = Effect.gen(function*() {
    while ((yield* bridge.speech)._tag !== "Quiet") yield* Effect.sleep("100 millis")
    yield* Effect.sleep("600 millis")
  })

  // VAD-style silence ticks between lines. Cannot fail.
  const lastEnd = yield* Ref.make(Number.NEGATIVE_INFINITY)
  yield* Effect.gen(function*() {
    while (true) {
      yield* Effect.sleep("250 millis")
      const end = yield* Ref.get(lastEnd)
      const t = (yield* Effect.clockWith((c) => c.currentTimeMillis)) / 1000
      if (Number.isFinite(end) && t - end >= 0.5) yield* bridge.tick(t - end)
    }
  }).pipe(Effect.forkScoped)

  return { holdForEggHead }
})
