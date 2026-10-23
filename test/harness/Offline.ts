/**
 * Offline: play a scenario through the real call loop (src/Call.ts `play`) and the real
 * Bridge, Router, Gate and Conversation, in virtual time. Only the edges are stand-ins, all
 * built from the scenario's own data:
 *
 *   Decider       Hints.hinted(lines), fixed latency        what each line's `decider` says
 *   CheckSource   MockSource over data/world.json + `world`
 *   Investigator  from `agent`: none, or one that answers from the world (+ `sees`) after a delay
 *   Writer        Writer.template, holding the floor while it writes
 *   Sound         estimated word marks, no audio
 *
 * The clock moves in 50 ms steps until the call publishes `done`; a call still running after
 * `maxS` of virtual time is reported as a hang, not waited on.
 */
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import world from "../../data/world.json" with { type: "json" }
import { Bridge } from "../../src/runtime/Bridge.ts"
import { type AgentPlan, type Call, Hold, type Logged, play, type WorldPatch } from "../../src/runtime/Call.ts"
import { MockSource, type World } from "../../src/domain/Checks.ts"
import { hinted } from "../../src/runtime/Hints.ts"
import { direct, Investigator } from "../../src/runtime/Investigator.ts"
import { judge, OFFLINE, type Report, render } from "../../src/runtime/Judge.ts"
import { Sound } from "../../src/runtime/Sound.ts"
import { SupportError, Writer } from "../../src/domain/Speaker.ts"
import { patch, Tuning, type TuningPatch } from "../../src/domain/Tuning.ts"

export interface OfflineOptions {
  /** Build the Bridge with these numbers instead of the defaults (test/Mutants.test.ts). */
  readonly tuning?: TuningPatch
  /** Decider latency per batch; the hosted API's is ~150 ms server-side. */
  readonly deciderLatencyMs?: number
  /** Virtual-time cap: a call still running after this long is a hang. */
  readonly maxS?: number
}

const STEP_MS = 50
const AGENT_DEFAULTS = { confirmS: 3, answerS: 3 } // about what pi takes
const AGENT_TIMEOUT_S = 60 // demo/server.ts --agent-timeout

const overlay = (base: World, patchWith: WorldPatch | undefined): World =>
  patchWith === undefined ? base : {
    ...base,
    checks: Object.fromEntries(
      [...new Set([...Object.keys(base.checks), ...Object.keys(patchWith)])].map((r) => [r, { ...base.checks[r], ...patchWith[r] }])
    )
  }

const scriptedInvestigator = (plan: Exclude<AgentPlan, false>, seen: World) =>
  Layer.effect(Investigator, Effect.gen(function*() {
    const { source } = yield* MockSource.make(seen)
    const d = direct(source)
    const after = <A>(seconds: number, job: Effect.Effect<A, SupportError>) =>
      plan.fails === "timeout"
        ? Effect.sleep(`${AGENT_TIMEOUT_S} seconds`).pipe(Effect.andThen(Effect.fail(new SupportError({ operation: "investigate", cause: "timed out" }))))
        : Effect.sleep(`${seconds} seconds`).pipe(
          Effect.andThen(plan.fails === "error" ? Effect.fail(new SupportError({ operation: "investigate", cause: "scripted failure" })) : job)
        )
    return Investigator.of({
      name: "scripted",
      confirm: (task, item) => after(plan.confirmS ?? AGENT_DEFAULTS.confirmS, d.confirm(task, item)),
      answer: (task, question) => after(plan.answerS ?? AGENT_DEFAULTS.answerS, d.answer(task, question))
    })
  }))

const layerFor = (call: Call, options: OfflineOptions) => {
  const fast = overlay(world as World, call.world)
  const plan = call.agent ?? {}
  const writing = Layer.provideMerge(Hold.whileWriting, Layer.merge(Writer.template, Hold.layer))
  const deps = Layer.mergeAll(
    hinted(call.lines, { latencyMs: options.deciderLatencyMs ?? 150 }),
    MockSource.layer(fast),
    writing,
    Sound.estimated,
    plan === false ? Layer.empty : scriptedInvestigator(plan, overlay(fast, plan.sees)),
    Layer.succeed(Tuning, patch(options.tuning ?? {}))
  )
  return Bridge.layer.pipe(Layer.provideMerge(deps))
}

export class Hang extends Error {}

/** Play the call to the end in virtual time; the log is what a live run saves. */
export const record = (call: Call, options: OfflineOptions = {}): Effect.Effect<ReadonlyArray<Logged>> =>
  Effect.gen(function*() {
    const log: Array<Logged> = []
    const fiber = yield* play(call, {
      mode: "text",
      writer: "template",
      agent: call.agent === false ? "none" : "scripted",
      publish: (m) => Effect.sync(() => void log.push(m))
    }).pipe(Effect.scoped, Effect.provide(layerFor(call, options)), Effect.forkChild)
    const capMs = (options.maxS ?? 600) * 1000
    for (let t = 0; fiber.pollUnsafe() === undefined && t < capMs; t += STEP_MS) yield* TestClock.adjust(`${STEP_MS} millis`)
    const exit = fiber.pollUnsafe()
    if (exit === undefined) {
      yield* Fiber.interrupt(fiber)
      return yield* Effect.die(new Hang(`"${call.title}" still running after ${capMs / 1000} s of virtual time (last: ${JSON.stringify(log.at(-1)?.type)})`))
    }
    if (Exit.isFailure(exit)) return yield* Effect.die(new Error(`"${call.title}" failed: ${Cause.pretty(exit.cause)}`))
    return log
  }).pipe(Effect.provide(TestClock.layer()))

/** The Report, for tests that look at failures (mutants). */
export const score = (call: Call, options: OfflineOptions = {}): Effect.Effect<Report> =>
  Effect.flatMap(record(call, options), (log) => Effect.fromResult(judge(call, log, OFFLINE)).pipe(Effect.orDie))

export class BehaviourMismatch extends Error {
  constructor(readonly report: Report) {
    super(render(report, { onlyFailures: true }))
  }
}

/** Record, judge, and fail with the rendered report when anything differs. */
export const behaves = (call: Call, options: OfflineOptions = {}): Effect.Effect<Report, BehaviourMismatch> =>
  Effect.flatMap(score(call, options), (report) => (report.passed ? Effect.succeed(report) : Effect.fail(new BehaviourMismatch(report))))
