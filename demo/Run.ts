/**
 * Plays a scripted call in real time and reports every step to the meeting page and the
 * dashboard. The call loop itself is src/Call.ts (shared with the offline scenarios); this file
 * adds what only the demo has:
 *
 * - stats for the page (Decider batches and latency, Bedrock calls, agent tasks);
 * - transcribe mode: the call audio is streamed to Amazon Transcribe and the Bridge hears what
 *   Transcribe returns. The speaker is the line playing at that moment (a meeting platform
 *   knows who is unmuted); speaker identity is not something the Decider needs.
 */
import { Context, Duration, Effect, Layer, Option, Ref, Stream } from "effect"
import { DecisionModel } from "effect/ai"
import { Bridge } from "../src/runtime/Bridge.ts"
import { type Call, type Logged, play, type PlayOptions, session } from "../src/runtime/Call.ts"
import { transcribe, Voice } from "./Voice.ts"

export interface Stats {
  readonly lines: number
  readonly deciderBatches: number
  readonly deciderMsP50: number
  readonly bedrockCalls: number
  readonly agentTasks: number
  readonly spoke: number
}

/** Messages only the page shows; the run log the Judge reads does not need them. */
export type PageOnly = { readonly type: "stats"; readonly stats: Stats } | { readonly type: "status"; readonly text: string }

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

export interface RunOptions {
  readonly mode: "text" | "transcribe"
  readonly writer: string
  readonly agent: string
  readonly originMs: number
  readonly bedrockCalls: Effect.Effect<number>
  readonly publish: (m: Logged | PageOnly) => Effect.Effect<void>
}

const DEFAULT_WAIT_S = 30

export const run = Effect.fnUntraced(function*(call: Call, options: RunOptions) {
  const bridge = yield* Bridge
  const meter = yield* DeciderMeter
  let lines = 0
  let spoke = 0

  const stats = Effect.gen(function*() {
    const ms = [...(yield* meter.batches)].sort((a, b) => a - b)
    return {
      lines,
      deciderBatches: ms.length,
      deciderMsP50: ms.length ? Math.round(ms[Math.floor(ms.length / 2)]!) : 0,
      bedrockCalls: yield* options.bedrockCalls,
      agentTasks: (yield* bridge.state).tasks,
      spoke
    } satisfies Stats
  })

  // fresh stats follow every decision and every line Egg Head says
  const publish = (m: Logged) =>
    Effect.gen(function*() {
      if (m.type === "line") lines = m.index + 1
      if (m.type === "egghead") spoke++
      if (m.type === "done") yield* options.publish({ type: "stats", stats: yield* stats })
      yield* options.publish(m)
      if (m.type === "event" || m.type === "egghead") yield* options.publish({ type: "stats", stats: yield* stats })
    })
  const playOptions: PlayOptions = { mode: options.mode, writer: options.writer, agent: options.agent, publish, originMs: options.originMs }

  if (options.mode === "text") return yield* play(call, playOptions)

  // Audio for Transcribe: each line's PCM, then silence for the pause (and while Egg Head talks).
  const voice = yield* Voice
  const pcms = yield* Effect.forEach(call.lines, (l) => Effect.map(voice.speak(call.voices[l.speaker] ?? "Joanna", l.text), (c) => c.pcm))
  const s = yield* session(call, playOptions)
  const CHUNK = 3200 // 100 ms of 16 kHz 16-bit
  const silence = new Uint8Array(CHUNK)
  const runFork = Effect.runForkWith(yield* Effect.context<never>())
  const settle = (effect: Effect.Effect<void>) => new Promise<void>((resolve) => runFork(Effect.ensuring(effect, Effect.sync(resolve))))
  const offsets: Array<number> = [] // audio-time start of each line, seconds
  let audioS = 0
  const pace = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const audio = (async function*() {
    for (let i = 0; i < call.lines.length; i++) {
      await settle(s.begin(i)) // the line starts playing on the page; humans wait for Egg Head before it
      offsets[i] = audioS
      const pcm = pcms[i]!
      for (let o = 0; o < pcm.length; o += CHUNK) {
        yield pcm.subarray(o, o + CHUNK)
        audioS += Math.min(CHUNK, pcm.length - o) / 2 / 16000
        await pace(100)
      }
      runFork(s.played(i, Option.none()))
      const pauseChunks = Math.round(call.lines[i]!.pause * 10)
      for (let k = 0; k < pauseChunks; k++) {
        yield silence
        audioS += 0.1
        await pace(100)
      }
      const wait = call.lines[i]!.waitForEggHead
      if (wait !== undefined) await settle(s.holdFor(i, wait || DEFAULT_WAIT_S))
    }
    for (let k = 0; k < 30; k++) {
      yield silence
      await pace(100)
    }
  })()
  yield* transcribe(audio).pipe(
    Stream.runForEach((seg) => s.hear(Math.max(0, offsets.findLastIndex((o) => o <= seg.startS + 0.05)), seg.text))
  )
  return yield* s.finish
})
