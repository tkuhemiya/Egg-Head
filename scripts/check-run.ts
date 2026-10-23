/**
 * Score a saved run against its scenario's expectations, line by line.
 *
 *   npx tsx scripts/check-run.ts latest                                # newest file in demo/out/runs/
 *   npx tsx scripts/check-run.ts demo/out/runs/2026-10-23T09-14-02-113Z.json
 *   npx tsx scripts/check-run.ts latest --call data/calls/checkout-incident.json   # re-judge with an edited scenario
 *
 * Exit 0: every line behaved as expected. 1: some did not. 2: could not score (unreadable
 * file, or a run of a different script).
 *
 * A run file embeds the scenario it played; older files name it by path (`call`). Live runs get
 * the live tolerance (1 s late for Decider, ASR and voice latency; never early).
 */
import { Console, Effect, Result, Schema } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { parseArgs } from "node:util"
import { type Call, decodeCall, decodeLog } from "../src/Call.ts"
import { judge, LIVE, render } from "../src/Judge.ts"

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { call: { type: "string" } } })
const RUNS = "demo/out/runs/"

class CannotScore extends Schema.TaggedError<CannotScore>()("CannotScore", { reason: Schema.String }) {}

const RunFile = Schema.Union([
  Schema.Struct({ scenario: Schema.Unknown, run: Schema.Record(Schema.String, Schema.Unknown), log: Schema.Array(Schema.Unknown) }),
  // before scenarios were embedded
  Schema.Struct({ call: Schema.String, mode: Schema.String, agent: Schema.String, history: Schema.Array(Schema.Unknown) })
])

const readJson = (path: string) =>
  Effect.try({ try: () => JSON.parse(readFileSync(path, "utf8")) as unknown, catch: (e) => new CannotScore({ reason: `${path}: ${String(e)}` }) })

const loadCall = (input: unknown, from: string): Effect.Effect<Call, CannotScore> =>
  decodeCall(input).pipe(Effect.mapError((e) => new CannotScore({ reason: `${from}: ${e.message}` })))

const program = Effect.gen(function*() {
  const arg = positionals[0] ?? "latest"
  const path = arg === "latest"
    ? yield* Effect.try({
      try: () => RUNS + readdirSync(RUNS).filter((f) => f.endsWith(".json")).sort().at(-1)!,
      catch: () => new CannotScore({ reason: `no runs in ${RUNS} yet (npm run demo)` })
    })
    : arg
  const file = yield* Schema.decodeUnknownEffect(RunFile)(yield* readJson(path)).pipe(
    Effect.mapError((e) => new CannotScore({ reason: `${path} is not a run file: ${e.message}` }))
  )
  const [embedded, meta, entries] = "scenario" in file
    ? [Effect.succeed(file.scenario), file.run, file.log] as const
    : [readJson(file.call), { mode: file.mode, agent: file.agent, call: file.call }, file.history] as const
  const call = args.call ? yield* loadCall(yield* readJson(args.call), args.call) : yield* loadCall(yield* embedded, path)
  const log = yield* decodeLog(entries).pipe(Effect.mapError((e) => new CannotScore({ reason: `${path}: entry ${e.index}: ${e.reason}` })))
  yield* Console.log(`${path}\n${Object.entries(meta).map(([k, v]) => `${k} ${String(v)}`).join(" · ")}`)
  if (meta.agent === "none" && call.agent !== false) {
    yield* Console.log("note: this run had no Investigator, but the scenario expects one; its agent lines cannot pass")
  }
  const judged = judge(call, log, LIVE)
  if (Result.isFailure(judged)) {
    return yield* new CannotScore({ reason: `not a run of this scenario: line ${judged.failure.index} was "${judged.failure.recorded}", the scenario has "${judged.failure.scripted}"` })
  }
  yield* Console.log(render(judged.success))
  return judged.success.passed ? 0 : 1
})

Effect.runPromise(program.pipe(Effect.catchTag("CannotScore", (e) => Effect.as(Console.error(e.reason), 2)))).then((code) => process.exit(code))
