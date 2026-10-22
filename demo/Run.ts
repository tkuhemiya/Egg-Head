/**
 * Plays a scripted call in real time through the Bridge and reports every step to the
 * dashboard. Two modes:
 *
 * - text: each line's text goes to the Bridge when its audio ends (the transcript is known).
 * - transcribe: the call audio is streamed to Amazon Transcribe and the Bridge hears what
 *   Transcribe returns. The speaker is the line playing at that moment (a meeting platform
 *   knows who is unmuted); speaker identity is not something the Decider needs.
 *
 * Silence is measured, not scripted: the Bridge hears a line when it ends, then gets VAD-style
 * silence ticks until the next line starts. Humans pause for Egg Head when it speaks.
 */
import { Clock, Context, Duration, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import { DecisionModel } from "effect/ai"
import { Bridge, Event } from "../src/Bridge.ts"
import { Writer } from "../src/Speaker.ts"
import { type Clip, transcribe, Voice } from "./Voice.ts"

export const Call = Schema.Struct({
  title: Schema.String,
  voices: Schema.Record(Schema.String, Schema.String),
  lines: Schema.Array(Schema.Struct({
    speaker: Schema.String,
    text: Schema.String,
    pause: Schema.Number,
    expect: Schema.String
  }))
})
export type Call = typeof Call.Type

export type Message =
  | { readonly type: "meta"; readonly title: string; readonly mode: string; readonly writer: string; readonly lines: number }
  | { readonly type: "line"; readonly index: number; readonly speaker: string; readonly text: string; readonly audio: string; readonly durationS: number; readonly expect: string }
  | { readonly type: "heard"; readonly index: number; readonly speaker: string; readonly text: string }
  | { readonly type: "event"; readonly index: number; readonly event: unknown }
  | { readonly type: "floor"; readonly index: number }
  | { readonly type: "status"; readonly text: string }
  | { readonly type: "egghead"; readonly index: number; readonly text: string; readonly audio: string; readonly durationS: number }
  | { readonly type: "stats"; readonly stats: Stats }
  | { readonly type: "done" }

export interface Stats {
  readonly lines: number
  readonly deciderBatches: number
  readonly deciderMsP50: number
  readonly bedrockCalls: number
  readonly spoke: number
}

/** Counts DecisionModel calls and their latency (wraps the real provider). */
export class DeciderMeter extends Context.Service<DeciderMeter, {
  readonly batches: Effect.Effect<ReadonlyArray<number>> // ms per batch
}>()("egghead/demo/DeciderMeter") {
  static readonly layer = Layer.effectContext(Effect.gen(function*() {
    const inner = yield* DecisionModel.DecisionModel
    const times = yield* Ref.make<ReadonlyArray<number>>([])
    const model: DecisionModel.DecisionModel = {
      ...inner,
      decide: (definition, options) =>
        Effect.timed(inner.decide(definition, options)).pipe(
          Effect.tap(([d]) => Ref.update(times, (t) => [...t, Duration.toMillis(d)])),
          Effect.map(([, r]) => r)
        )
    }
    return Context.make(DecisionModel.DecisionModel, model).pipe(
      Context.add(DeciderMeter, DeciderMeter.of({ batches: Ref.get(times) }))
    )
  }))
}

/**
 * Who has the floor. When the gate opens, Egg Head takes it at once (the humans pause) even
 * though Bedrock still needs a few seconds to write the sentence.
 */
export class Floor extends Context.Service<Floor, {
  /** Humans wait until this Clock time, in seconds. */
  readonly until: Ref.Ref<number>
}>()("egghead/demo/Floor") {
  static readonly layer = Layer.effect(Floor, Effect.map(Ref.make(0), (until) => Floor.of({ until })))

  /** Wraps the Writer: taking the floor starts when writing starts. */
  static readonly holdWhileWriting = Layer.effect(Writer, Effect.gen(function*() {
    const inner = yield* Writer
    const { until } = yield* Floor
    return Writer.of({
      write: (item) =>
        Effect.flatMap(Clock.currentTimeMillis, (ms) => Ref.set(until, ms / 1000 + 30)).pipe(Effect.andThen(inner.write(item)))
    })
  }))
}

export interface RunOptions {
  readonly mode: "text" | "transcribe"
  readonly writer: string
  readonly bedrockCalls: Effect.Effect<number>
  readonly publish: (m: Message) => Effect.Effect<void>
}

const encodeEvent = Schema.encodeSync(Schema.toCodecJson(Event))
const TICK_MS = 250
const ASR_DELAY_S = 0.3 // a streaming recogniser finalises a segment about this long after speech ends

export const run = Effect.fnUntraced(function*(call: Call, options: RunOptions) {
  const bridge = yield* Bridge
  const voice = yield* Voice
  const meter = yield* DeciderMeter
  const { publish } = options
  const now = Effect.map(Clock.currentTimeMillis, (ms) => ms / 1000)
  const clips: Array<Clip> = yield* Effect.forEach(call.lines, (l) => voice.speak(call.voices[l.speaker] ?? "Joanna", l.text))
  const current = yield* Ref.make(0) // line whose audio is playing or just ended
  const lastEnd = yield* Ref.make(Number.NEGATIVE_INFINITY)
  const spoke = yield* Ref.make(0)
  const humansWaitUntil = (yield* Floor).until // Clock seconds; humans pause while Egg Head talks

  const stats = Effect.gen(function*() {
    const ms = [...(yield* meter.batches)].sort((a, b) => a - b)
    return {
      lines: (yield* Ref.get(current)) + 1,
      deciderBatches: ms.length,
      deciderMsP50: ms.length ? Math.round(ms[Math.floor(ms.length / 2)]!) : 0,
      bedrockCalls: yield* options.bedrockCalls,
      spoke: yield* Ref.get(spoke)
    } satisfies Stats
  })

  // Every Bridge decision goes to the dashboard; when Egg Head speaks, voice it and hold the humans.
  const lineOfTurn = yield* Ref.make<ReadonlyArray<number>>([]) // Bridge turn -> call line
  const hear = (i: number, speaker: string, text: string, silenceS: number) =>
    Ref.update(lineOfTurn, (t) => [...t, i]).pipe(Effect.andThen(bridge.hear(speaker, text, silenceS)))

  const onEvent = (ev: Event) =>
    Effect.gen(function*() {
      const index = (yield* Ref.get(lineOfTurn))[ev.turn] ?? (yield* Ref.get(current))
      yield* publish({ type: "event", index, event: encodeEvent(ev) })
      if (Option.isSome(ev.said)) {
        yield* Ref.set(humansWaitUntil, (yield* now) + 30) // hold the next line while the voice is made
        const clip = yield* voice.speak(call.voices["Egg Head"] ?? "Matthew", ev.said.value)
        yield* Ref.update(spoke, (n) => n + 1)
        yield* Ref.set(humansWaitUntil, (yield* now) + clip.durationS + 0.6)
        yield* publish({ type: "egghead", index, text: ev.said.value, audio: `/audio/${clip.file}`, durationS: clip.durationS })
      }
      yield* publish({ type: "stats", stats: yield* stats })
    })
  yield* bridge.changes.pipe(Stream.runForEach(onEvent), Effect.forkScoped)
  yield* Effect.yieldNow

  // Announce when Egg Head takes the floor (the gate opened; the line is being written).
  let announced = 0
  const floorWatch = yield* Effect.gen(function*() {
    while (true) {
      yield* Effect.sleep("100 millis")
      const hold = yield* Ref.get(humansWaitUntil)
      if (hold !== announced && hold - (yield* now) > 20) {
        announced = hold
        yield* publish({ type: "floor", index: yield* Ref.get(current) })
      }
    }
  }).pipe(Effect.forkScoped)

  // VAD-style silence ticks between lines
  const ticker = yield* Effect.gen(function*() {
    while (true) {
      yield* Effect.sleep(`${TICK_MS} millis`)
      const end = yield* Ref.get(lastEnd)
      const t = yield* now
      if (Number.isFinite(end) && t - end >= 0.5) yield* bridge.tick(t - end)
    }
  }).pipe(Effect.forkScoped)

  // Humans wait while Egg Head talks (the hold can grow while we wait).
  const holdForEggHead = Effect.gen(function*() {
    while ((yield* Ref.get(humansWaitUntil)) > (yield* now)) yield* Effect.sleep("100 millis")
  })

  const startLine = (i: number) =>
    Effect.gen(function*() {
      yield* holdForEggHead
      const l = call.lines[i]!
      yield* Ref.set(current, i)
      yield* Ref.set(lastEnd, Number.NEGATIVE_INFINITY) // someone is talking
      yield* publish({ type: "line", index: i, speaker: l.speaker, text: l.text, audio: `/audio/${clips[i]!.file}`, durationS: clips[i]!.durationS, expect: l.expect })
      yield* Effect.sleep(`${Math.round(clips[i]!.durationS * 1000)} millis`)
      yield* Ref.set(lastEnd, yield* now)
    })

  yield* publish({ type: "meta", title: call.title, mode: options.mode, writer: options.writer, lines: call.lines.length })

  const hearing: Array<Fiber.Fiber<unknown, unknown>> = []
  if (options.mode === "text") {
    for (let i = 0; i < call.lines.length; i++) {
      const l = call.lines[i]!
      yield* startLine(i)
      yield* Effect.sleep(`${ASR_DELAY_S * 1000} millis`)
      yield* publish({ type: "heard", index: i, speaker: l.speaker, text: l.text })
      // the call does not wait for Egg Head to think (the Bridge takes one utterance at a time)
      hearing.push(yield* Effect.forkScoped(hear(i, l.speaker, l.text, (yield* now) - (yield* Ref.get(lastEnd)))))
      if (l.pause > ASR_DELAY_S) yield* Effect.sleep(`${Math.round((l.pause - ASR_DELAY_S) * 1000)} millis`)
    }
  } else {
    // Audio for Transcribe: each line's PCM, then silence for the pause (and while Egg Head talks).
    const CHUNK = 3200 // 100 ms of 16 kHz 16-bit
    const silence = new Uint8Array(CHUNK)
    const runFork = Effect.runForkWith(yield* Effect.context<never>())
    const offsets: Array<number> = [] // audio-time start of each line, seconds
    let audioS = 0
    const pace = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const audio = (async function*() {
      for (let i = 0; i < call.lines.length; i++) {
        await new Promise<void>((resolve) => runFork(Effect.ensuring(startLineAudio(i), Effect.sync(resolve))))
        offsets[i] = audioS
        const pcm = clips[i]!.pcm
        for (let o = 0; o < pcm.length; o += CHUNK) {
          yield pcm.subarray(o, o + CHUNK)
          audioS += Math.min(CHUNK, pcm.length - o) / 2 / 16000
          await pace(100)
        }
        runFork(Ref.set(lastEnd, Date.now() / 1000))
        const pauseChunks = Math.round(call.lines[i]!.pause * 10)
        for (let k = 0; k < pauseChunks; k++) {
          yield silence
          audioS += 0.1
          await pace(100)
        }
      }
      for (let k = 0; k < 30; k++) {
        yield silence
        await pace(100)
      }
    })()
    // the line starts playing in the dashboard; humans wait for Egg Head before it
    const startLineAudio = (i: number) =>
      Effect.gen(function*() {
        yield* holdForEggHead
        const l = call.lines[i]!
        yield* Ref.set(current, i)
        yield* Ref.set(lastEnd, Number.NEGATIVE_INFINITY)
        yield* publish({ type: "line", index: i, speaker: l.speaker, text: l.text, audio: `/audio/${clips[i]!.file}`, durationS: clips[i]!.durationS, expect: l.expect })
      })
    yield* transcribe(audio).pipe(
      Stream.runForEach((seg) =>
        Effect.gen(function*() {
          const i = Math.max(0, offsets.findLastIndex((o) => o <= seg.startS + 0.05))
          const speaker = call.lines[i]!.speaker
          yield* publish({ type: "heard", index: i, speaker, text: seg.text })
          const end = yield* Ref.get(lastEnd)
          yield* hear(i, speaker, seg.text, Number.isFinite(end) ? (yield* now) - end : 0)
        })
      )
    )
  }

  yield* Fiber.joinAll(hearing)
  yield* Effect.sleep("1500 millis")
  yield* Fiber.interrupt(ticker)
  yield* Fiber.interrupt(floorWatch)
  yield* publish({ type: "stats", stats: yield* stats })
  yield* publish({ type: "done" })
  return yield* bridge.state
})

