/**
 * Call: a stretch of a voice call written down (a scenario), and the real-time loop that
 * plays it through the Bridge. The demo, the offline scenarios (TestClock) and live scoring
 * all run this one loop, so what the tests time is what the demo does: silence ticks, partial
 * transcripts from word marks, the humans holding while Egg Head talks, `waitForEggHead`.
 *
 * The loop runs on `Clock` only and stamps every message it publishes with `at`, so a TestClock
 * run and a wall-clock run produce the same log. Who answers (Decider), how lines sound (Sound)
 * and who investigates come in as services. Transcribe mode (demo/Run.ts) drives the same
 * `session` from audio.
 */
import { Clock, Context, Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import { Bridge, type BridgeError, type BridgeState, Event } from "./Bridge.ts"
import { CHECKS, World } from "../domain/Checks.ts"
import { describe, Expect, Invariant } from "../domain/Expect.ts"
import { Hints } from "./Hints.ts"
import { Marks, Sound, type Spoken } from "./Sound.ts"
import { Writer } from "../domain/Speaker.ts"

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

/** resource -> check -> result, laid over data/world.json. */
export const WorldPatch = World.fields.checks.check(Schema.makeFilter((w) => {
  const bad = Object.values(w).flatMap((checks) => Object.keys(checks)).filter((c) => !Object.hasOwn(CHECKS, c))
  return bad.length === 0 ? undefined : `unknown checks: ${bad.join(", ")}`
}))
export type WorldPatch = typeof WorldPatch.Type

/**
 * The Investigator offline (live runs use the real agent and ignore this). `false`: none.
 * Otherwise it answers from the world after `confirmS` / `answerS`, sees `sees` over the world
 * (to script an agent that overrules the fast check), and can fail outright or time out.
 */
export const AgentPlan = Schema.Union([
  Schema.Literal(false),
  Schema.Struct({
    confirmS: Schema.optionalKey(Schema.Number),
    answerS: Schema.optionalKey(Schema.Number),
    sees: Schema.optionalKey(WorldPatch),
    fails: Schema.optionalKey(Schema.Literals(["error", "timeout"]))
  })
])
export type AgentPlan = typeof AgentPlan.Type

export const CallLine = Schema.Struct({
  speaker: Schema.String,
  text: Schema.String,
  /** Seconds of quiet after the line before the next one starts. */
  pause: Schema.Number,
  /** What Egg Head does because of this line. Omitted: quiet. */
  expect: Schema.optionalKey(Expect),
  /** Why, in prose. Shown beside the expectation, never judged. */
  why: Schema.optionalKey(Schema.String),
  /** Humans hold after this line until Egg Head has said what it is working on (at most this many s). */
  waitForEggHead: Schema.optionalKey(Schema.Number),
  /** What a scripted Decider answers on this line (offline and --rehearsal; live runs ask Decider). */
  decider: Schema.optionalKey(Hints)
})
export type CallLine = typeof CallLine.Type

export const Call = Schema.Struct({
  title: Schema.String,
  about: Schema.optionalKey(Schema.String),
  voices: Schema.Record(Schema.String, Schema.String),
  /** What the fast checks see, over data/world.json (offline only). */
  world: Schema.optionalKey(WorldPatch),
  agent: Schema.optionalKey(AgentPlan),
  never: Schema.optionalKey(Schema.Array(Invariant)),
  lines: Schema.Array(CallLine)
})
export type Call = typeof Call.Type

// Strict, so a typo in a scenario (`"clam": 0.9`) fails instead of meaning "not a claim".
const STRICT = { onExcessProperty: "error" } as const
export const decodeCall = Schema.decodeUnknownEffect(Call, STRICT)
export const decodeCallSync = Schema.decodeUnknownSync(Call, STRICT)

export const expectOf = (line: CallLine): Expect => line.expect ?? []

// ---------------------------------------------------------------------------
// What the loop publishes: the meeting page's feed, and the run log the Judge reads
// ---------------------------------------------------------------------------

export const SpokenKind = Schema.Literals(["flag", "ack", "answer", "barge", "line", "retract"])

const logged = <const T extends string, const F extends Schema.Struct.Fields>(type: T, fields: F) =>
  Schema.Struct({ type: Schema.Literal(type), at: Schema.Number, ...fields })

/** `at`: ms since the call started, from Clock. `index`: the call line the message is about. */
export const Logged = Schema.Union([
  logged("meta", { title: Schema.String, mode: Schema.String, writer: Schema.String, agent: Schema.String, lines: Schema.Int, people: Schema.Array(Schema.String) }),
  logged("line", { index: Schema.Int, speaker: Schema.String, text: Schema.String, audio: Schema.String, durationS: Schema.Number, expect: Schema.String, marks: Marks }),
  logged("cut", { index: Schema.Int, speaker: Schema.String, text: Schema.String }),
  logged("heard", { index: Schema.Int, speaker: Schema.String, text: Schema.String }),
  logged("event", { index: Schema.Int, event: Event }),
  logged("floor", { index: Schema.Int }),
  logged("hold", { index: Schema.Int, on: Schema.Boolean }),
  logged("egghead", { index: Schema.Int, text: Schema.String, audio: Schema.String, durationS: Schema.Number, marks: Marks, kind: SpokenKind }),
  logged("done", {})
])
export type Logged = typeof Logged.Type
export type Message = Logged extends infer M ? M extends unknown ? Omit<M, "at"> : never : never

/** JSON for the page and the run file. */
export const LoggedJson = Schema.toCodecJson(Logged)
export const encodeLogged = Schema.encodeSync(LoggedJson)

/** Messages only the page uses (status, stats, reset); a run log skips them. */
const LOG_TYPES = new Set<string>(Logged.members.map((m) => m.fields.type.literal))

export class LogError extends Schema.TaggedError<LogError>()("LogError", {
  index: Schema.Int,
  reason: Schema.String
}) {}

/** Decode a saved history: page-only messages are skipped, anything else malformed is an error. */
export const decodeLog = (entries: ReadonlyArray<unknown>): Effect.Effect<ReadonlyArray<Logged>, LogError> =>
  Effect.forEach(
    entries.flatMap((e, i) => (LOG_TYPES.has(String((e as { type?: unknown } | null)?.type)) ? [[e, i] as const] : [])),
    ([e, i]) => Schema.decodeUnknownEffect(LoggedJson)(e).pipe(Effect.mapError((err) => new LogError({ index: i, reason: err.message })))
  )

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** Clock the humans wait on while Egg Head writes. Not `src/domain/Floor.ts` (who is talking). */
export class Hold extends Context.Service<Hold, {
  /** Humans wait until this Clock time, in seconds. */
  readonly until: Ref.Ref<number>
}>()("egghead/Hold") {
  static readonly layer = Layer.effect(Hold, Effect.map(Ref.make(0), (until) => Hold.of({ until })))

  /** Wraps the Writer: the humans pause while Bedrock writes. */
  static readonly whileWriting = Layer.effect(Writer, Effect.gen(function*() {
    const inner = yield* Writer
    const { until } = yield* Hold
    return Writer.of({
      write: (item) =>
        Effect.flatMap(Clock.currentTimeMillis, (ms) => Ref.set(until, ms / 1000 + 30)).pipe(Effect.andThen(inner.write(item)))
    })
  }))
}

export interface PlayOptions {
  readonly mode: string
  readonly writer: string
  readonly agent: string
  readonly publish: (m: Logged) => Effect.Effect<void>
  /** Clock ms that `at` counts from. Default: when the call starts. */
  readonly originMs?: number
}

export const TICK_MS = 250
export const ASR_DELAY_S = 0.3 // a streaming recogniser finalises a segment about this long after speech ends
export const PARTIAL_DELAY_S = 0.25 // and shows a word as a partial result about this long after it is said
const DEFAULT_WAIT_S = 30

/** The parts of a call both drivers share: text mode below, and Transcribe in demo/Run.ts. */
export interface CallSession {
  /** Each line as it sounds. */
  readonly clips: ReadonlyArray<Spoken>
  /** Humans wait for Egg Head, then line i starts playing. */
  begin(i: number): Effect.Effect<void>
  /** Line i is over (cut off when Some): silence counts from now. */
  played(i: number, cut: Option.Option<string>): Effect.Effect<void>
  /** The recogniser's final text for line i goes to the Bridge, with the silence measured so far. */
  hear(i: number, text: string): Effect.Effect<Event, BridgeError>
  /** waitForEggHead: the call gives Egg Head the floor until its pending work is said. */
  holdFor(i: number, maxS: number): Effect.Effect<void>
  /** Let Egg Head finish, stop the clock-driven parts, publish `done`. */
  readonly finish: Effect.Effect<BridgeState>
}

export const session = Effect.fnUntraced(function*(call: Call, options: PlayOptions) {
  const bridge = yield* Bridge
  const sound = yield* Sound
  const humansWaitUntil = (yield* Hold).until // Clock seconds
  const nowMs = Clock.currentTimeMillis
  const now = Effect.map(nowMs, (ms) => ms / 1000)
  const origin = options.originMs ?? (yield* nowMs)
  const publish = (m: Message) => Effect.flatMap(nowMs, (ms) => options.publish({ ...m, at: ms - origin } as Logged))

  const clips = yield* Effect.forEach(call.lines, (l) => sound.speak(call.voices[l.speaker] ?? "Joanna", l.text))
  const current = yield* Ref.make(0) // line whose audio is playing or just ended
  const lastEnd = yield* Ref.make(Number.NEGATIVE_INFINITY)
  const lineOfTurn = yield* Ref.make<ReadonlyArray<number>>([]) // Bridge turn -> call line

  // Every Bridge decision is published; when Egg Head speaks, voice it and hold the humans.
  const onEvent = (ev: Event) =>
    Effect.gen(function*() {
      const index = (yield* Ref.get(lineOfTurn))[ev.turn] ?? (yield* Ref.get(current))
      yield* publish({ type: "event", index, event: ev })
      const said = ev.speech !== undefined && Option.isSome(ev.speech) ? ev.speech.value.text : Option.getOrUndefined(ev.said)
      const kind = ev.speech !== undefined && Option.isSome(ev.speech) ? ev.speech.value.kind : ev.saidKind ?? "line"
      const speechId = ev.speech !== undefined && Option.isSome(ev.speech) ? ev.speech.value.id : undefined
      if (said !== undefined) {
        yield* Ref.set(humansWaitUntil, (yield* now) + 30) // hold the next line while the voice is made
        const clip = yield* sound.speak(call.voices["Egg Head"] ?? "Matthew", said).pipe(
          Effect.tapError(() => speechId ? bridge.spoke(speechId, "dropped") : Effect.void)
        )
        yield* Ref.set(humansWaitUntil, (yield* now) + clip.durationS + 0.6)
        yield* publish({ type: "egghead", index, text: said, audio: clip.audio, durationS: clip.durationS, marks: clip.marks, kind: kind === "take" || kind === "retract" ? "line" : kind })
        if (speechId) {
          yield* Effect.sleep(`${Math.round(clip.durationS * 1000)} millis`).pipe(
            Effect.andThen(bridge.spoke(speechId, "finished")),
            Effect.forkScoped
          )
        }
      }
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
      if (Number.isFinite(end) && t - end >= 0.5) {
        yield* bridge.tick(t - end).pipe(Effect.catchCause((c) => Effect.logError(c)))
      }
    }
  }).pipe(Effect.forkScoped)

  // Humans wait while Egg Head talks (the hold can grow while they wait).
  const holdForEggHead = Effect.gen(function*() {
    while ((yield* Ref.get(humansWaitUntil)) > (yield* now)) yield* Effect.sleep("100 millis")
  })

  const holdFor = (i: number, maxS: number) =>
    Effect.gen(function*() {
      const until = (yield* now) + (maxS || DEFAULT_WAIT_S)
      if ((yield* bridge.pending) === 0) return
      yield* publish({ type: "hold", index: i, on: true })
      while ((yield* now) < until && ((yield* bridge.pending) > 0 || (yield* Ref.get(humansWaitUntil)) > (yield* now))) {
        yield* Effect.sleep("100 millis")
      }
      yield* publish({ type: "hold", index: i, on: false })
    })

  const line = (i: number) => call.lines[i]!

  yield* publish({
    type: "meta",
    title: call.title,
    mode: options.mode,
    writer: options.writer,
    agent: options.agent,
    lines: call.lines.length,
    people: [...new Set(call.lines.map((l) => l.speaker))]
  })

  return {
    clips,
    begin: (i) =>
      Effect.gen(function*() {
        yield* holdForEggHead
        yield* Ref.set(current, i)
        yield* Ref.set(lastEnd, Number.NEGATIVE_INFINITY) // someone is talking
        const l = line(i)
        const c = clips[i]!
        const expect = describe(l.expect ?? []) + (l.why ? ` · ${l.why}` : "")
        yield* publish({ type: "line", index: i, speaker: l.speaker, text: l.text, audio: c.audio, durationS: c.durationS, expect, marks: c.marks })
      }),
    played: (i, cut) =>
      Effect.gen(function*() {
        yield* Ref.set(lastEnd, yield* now)
        if (Option.isSome(cut)) yield* publish({ type: "cut", index: i, speaker: line(i).speaker, text: cut.value })
      }),
    hear: (i, text) =>
      Effect.gen(function*() {
        const { speaker } = line(i)
        yield* publish({ type: "heard", index: i, speaker, text })
        const end = yield* Ref.get(lastEnd)
        const silenceS = Number.isFinite(end) ? (yield* now) - end : 0
        yield* Ref.update(lineOfTurn, (t) => [...t, i])
        return yield* bridge.hear(speaker, text, silenceS)
      }),
    holdFor,
    finish: Effect.gen(function*() {
      // let Egg Head finish what it is working on before the call ends
      yield* holdFor(call.lines.length - 1, 20)
      yield* holdForEggHead
      yield* Effect.sleep("1500 millis")
      yield* Fiber.interrupt(ticker)
      yield* Fiber.interrupt(floorWatch)
      yield* publish({ type: "done" })
      return yield* bridge.state
    })
  } satisfies CallSession as CallSession
})

/**
 * Text mode: each line's text goes to the Bridge when its audio ends (the transcript is known).
 * While a line plays, the words heard so far go to `Bridge.partial` as a streaming recogniser's
 * partial results would, so Egg Head can cut a speaker off mid-line.
 */
export const play = Effect.fnUntraced(function*(call: Call, options: PlayOptions) {
  const bridge = yield* Bridge
  const s = yield* session(call, options)

  /** Play line i, feeding the words heard so far to Bridge.partial. Some(text) when Egg Head cut in. */
  const playLine = (i: number) =>
    Effect.gen(function*() {
      yield* s.begin(i)
      const l = call.lines[i]!
      const clip = s.clips[i]!
      const cut = yield* Deferred.make<string>()
      const words = clip.marks.words
      const startMs = yield* Clock.currentTimeMillis
      const partials = yield* Effect.gen(function*() {
        // a word shows as a partial result once the next one starts (the last one goes to hear())
        for (let k = 0; k < words.length - 1; k++) {
          const wait = startMs + words[k + 1]!.time + PARTIAL_DELAY_S * 1000 - (yield* Clock.currentTimeMillis)
          if (wait > 0) yield* Effect.sleep(`${Math.round(wait)} millis`)
          const text = words.slice(0, k + 1).map((w) => w.value).join(" ")
          const ev = yield* bridge.partial(l.speaker, text).pipe(Effect.catchCause(() => Effect.succeedNone))
          const barged = Option.isSome(ev) && (
            (ev.value.speech !== undefined && Option.isSome(ev.value.speech) && ev.value.speech.value.kind === "barge") ||
            Option.isSome(ev.value.said)
          )
          if (barged) {
            yield* Deferred.succeed(cut, text)
            return
          }
        }
      }).pipe(Effect.forkScoped)
      const ended = yield* Effect.raceFirst(
        Effect.as(Effect.sleep(`${Math.round(clip.durationS * 1000)} millis`), Option.none<string>()),
        Effect.map(Deferred.await(cut), Option.some)
      )
      yield* Fiber.interrupt(partials)
      yield* s.played(i, ended)
      return ended
    })

  const hearing: Array<Fiber.Fiber<unknown, BridgeError>> = []
  for (let i = 0; i < call.lines.length; i++) {
    const l = call.lines[i]!
    const cutAt = yield* playLine(i)
    yield* Effect.sleep(`${ASR_DELAY_S * 1000} millis`)
    // the call does not wait for Egg Head to think (the Bridge takes one utterance at a time)
    hearing.push(yield* Effect.forkScoped(s.hear(i, Option.match(cutAt, { onNone: () => l.text, onSome: (t) => `${t}—` }))))
    const pause = Option.isSome(cutAt) ? 0.2 : l.pause
    if (pause > ASR_DELAY_S) yield* Effect.sleep(`${Math.round((pause - ASR_DELAY_S) * 1000)} millis`)
    if (l.waitForEggHead !== undefined) {
      yield* Fiber.join(hearing[hearing.length - 1]!).pipe(Effect.ignore) // Egg Head has heard the line
      yield* s.holdFor(i, l.waitForEggHead)
    }
  }
  yield* Fiber.joinAll(hearing)
  return yield* s.finish
})
