/**
 * Fidelity check: run the runtime router (src/domain/Router.ts) over the research dataset against a
 * real Decider and score it like docs/research/decider/scripts/exp9_recall.py. The numbers should
 * land near exp 9's (held-out: claim P 0.88 R 0.90; route P 0.81 R 0.81). Hosted answers can
 * drift, and the runtime batches option rotations into one request (exp 8: within 0.002).
 *
 *   npm run replay -- dev        # or heldout; writes docs/research/decider/results/runtime_<split>.json
 */
import { Console, Duration, Effect, Layer, Option } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { CheckSource, MockSource } from "../src/domain/Checks.ts"
import * as Decider from "../src/runtime/Decider.ts"
import type { Turn } from "../src/domain/Questions.ts"
import { route } from "../src/domain/Router.ts"

const split = process.argv[2] ?? "dev"
const ROOT = new URL("../docs/research/decider/", import.meta.url)

interface Item {
  readonly id: string
  readonly split: string
  readonly context: ReadonlyArray<{ speaker: string; text: string }>
  readonly latest: { speaker: string; text: string }
  readonly labels: { is_claim: boolean; check: string | null; resource: string | null }
}

const items = readFileSync(new URL("data/dataset.jsonl", ROOT), "utf8").trim().split("\n")
  .map((l) => JSON.parse(l) as Item).filter((i) => i.split === split)

const gold = (it: Item) =>
  it.labels.is_claim && it.labels.check && it.labels.resource && it.labels.resource !== "unknown"
    ? `${it.labels.check}@${it.labels.resource}`
    : null

const prf = (tp: number, fp: number, fn: number) => {
  const p = tp + fp ? tp / (tp + fp) : 0
  const r = tp + fn ? tp / (tp + fn) : 0
  return { P: +p.toFixed(3), R: +r.toFixed(3), F1: +(p + r ? (2 * p * r) / (p + r) : 0).toFixed(3) }
}

const program = Effect.gen(function*() {
  const inventory = yield* (yield* CheckSource).inventory
  let done = 0
  const rows = yield* Effect.forEach(items, (it) =>
    Effect.gen(function*() {
      const turns: Array<Turn> = [...it.context, it.latest].map((t) => [t.speaker, t.text] as const)
      const [elapsed, r] = yield* Effect.timed(route(turns, inventory))
      if (++done % 20 === 0) yield* Console.log(`${done}/${items.length}`)
      const fired = r.action === "check"
        ? `${Option.getOrElse(r.check, () => "")}@${Option.getOrElse(r.resource, () => "")}`
        : null
      return { id: it.id, claim: r.scores.claim!, action: r.action, fired, gold: gold(it), isClaim: it.labels.is_claim, ms: Math.round(Duration.toMillis(elapsed)) }
    }), { concurrency: 2 })

  const claim = prf(
    rows.filter((r) => r.claim >= 0.5 && r.isClaim).length,
    rows.filter((r) => r.claim >= 0.5 && !r.isClaim).length,
    rows.filter((r) => r.claim < 0.5 && r.isClaim).length
  )
  const routing = prf(
    rows.filter((r) => r.fired && r.fired === r.gold).length,
    rows.filter((r) => r.fired && r.fired !== r.gold).length,
    rows.filter((r) => r.gold && r.fired !== r.gold).length
  )
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b)
  const out = {
    split,
    n: rows.length,
    claim,
    routing: { ...routing, fired: rows.filter((r) => r.fired).length, gold: rows.filter((r) => r.gold).length },
    escalated: rows.filter((r) => r.action === "escalate").length,
    rows
  }
  writeFileSync(new URL(`results/runtime_${split}.json`, ROOT), JSON.stringify(out, null, 1))
  const at = (q: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * q))]
  yield* Console.log(JSON.stringify({ ...out, rows: undefined, p50_ms: at(0.5), p95_ms: at(0.95) }, null, 1))
})

Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(Decider.layerFromEnv, MockSource.layer()))))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
