/**
 * Parity with the research pipeline the runtime ports (research/decider, exp 9 + final_eval).
 * Fixture: research/decider/scripts/export_runtime_parity.py.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import fixture from "./fixtures/research-parity.json" with { type: "json" }
import { CheckSource, MockSource } from "../src/Checks.ts"
import {
  checkCriteria,
  checkInstructions,
  CLAIM_LAYERS,
  claimProbability,
  FINISHED,
  finishedProbability,
  NONE_CHECK_DESCRIPTION,
  renderGate,
  renderKv,
  RESOURCE_INSTRUCTIONS,
  SELF_REPAIRED,
  type Turn,
  UNKNOWN_RESOURCE_DESCRIPTION
} from "../src/Questions.ts"
import { aliasHits, shortlist } from "../src/Router.ts"

describe("research parity", () => {
  it("asks the same questions, word for word and in the same order", () => {
    const { short, fact, status, hedge } = fixture.wording.claim
    assert.strictEqual(JSON.stringify(CLAIM_LAYERS), JSON.stringify({ short, fact, status, hedge }))
    assert.strictEqual(RESOURCE_INSTRUCTIONS, fixture.wording.resource)
    assert.strictEqual(UNKNOWN_RESOURCE_DESCRIPTION, fixture.wording.unknown)
    assert.strictEqual(NONE_CHECK_DESCRIPTION, fixture.wording.none_check)
    assert.strictEqual(checkInstructions("orders-db"), fixture.wording.check_orders_db)
    assert.strictEqual(SELF_REPAIRED, fixture.wording.self_repaired)
    assert.strictEqual(FINISHED, fixture.wording.finished)
  })

  it.effect("offers each resource's checks in the research order", () =>
    Effect.gen(function*() {
      const { checks } = yield* (yield* CheckSource).inventory
      assert.deepStrictEqual(checks, fixture.checks)
      assert.deepStrictEqual(Object.keys(checkCriteria(checks["orders-db"]!)), ["db_health", "alarm_state", "none"])
    }).pipe(Effect.provide(MockSource.layer())))

  it("renders the same states and finds the same resources", () => {
    for (const s of fixture.samples) {
      const turns = s.turns as unknown as ReadonlyArray<Turn>
      assert.strictEqual(renderKv(turns, 1), s.kv1, s.id)
      assert.strictEqual(renderKv(turns, 3), s.kv3, s.id)
      assert.deepStrictEqual(aliasHits(turns[turns.length - 1]![1]), s.aliases, s.id)
      assert.deepStrictEqual(shortlist(turns, Object.keys(fixture.checks)), s.shortlist, s.id)
      if (s.gate_state !== undefined) assert.strictEqual(renderGate(turns, s.silence_s!, s.ledger!), s.gate_state, s.id)
    }
  })

  it("combines the claim layers and scales `finished` with the dev-fit parameters", () => {
    for (const { p: [short, fact, status, hedge], out } of fixture.combo) {
      assert.closeTo(claimProbability({ short: short!, fact: fact!, status: status!, hedge: hedge! }), out, 1e-12)
    }
    for (const { p, out } of fixture.platt_fin) assert.closeTo(finishedProbability(p), out, 1e-12)
  })
})
