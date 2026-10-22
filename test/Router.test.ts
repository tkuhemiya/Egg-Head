import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { compare, inferAsserted } from "../src/Compare.ts"
import { CheckSource, MockSource } from "../src/Checks.ts"
import { ScriptedDecider } from "../src/Decider.ts"
import type { Turn } from "../src/Questions.ts"
import { aliasHits, average, decide, route, shortlist, T_ROUTE } from "../src/Router.ts"
import { scripted } from "./helpers.ts"

describe("compare", () => {
  it("compares the claim with the check in code", () => {
    assert.strictEqual(compare("healthy", "degraded"), "contradicts")
    assert.strictEqual(compare("unchanged", "changed"), "contradicts")
    assert.strictEqual(compare("degraded", "degraded"), "supports")
    assert.strictEqual(compare("unclear", "degraded"), "inconclusive")
    assert.strictEqual(compare(null, "degraded"), "inconclusive")
    assert.strictEqual(compare("changed", "healthy"), "inconclusive")
  })

  it("falls back to the wording when Decider says unclear", () => {
    assert.strictEqual(inferAsserted("We didn't deploy orders-api today."), "unchanged")
    assert.strictEqual(inferAsserted("The DB is fine, it's the API."), "healthy")
    assert.strictEqual(inferAsserted("Hmm, let me look."), "unclear")
  })
})

describe("code-first resource lookup", () => {
  it("finds resources by alias, else in the two turns before, else offers all", () => {
    assert.deepStrictEqual(aliasHits("The orders DB is fine"), ["orders-db"])
    assert.deepStrictEqual(aliasHits("auth and the payments api"), ["payments-api", "auth-service"])
    const all = ["orders-db", "orders-api"]
    const t = (...texts: Array<string>): Array<Turn> => texts.map((x) => ["X", x])
    assert.deepStrictEqual(shortlist(t("Look at orders-api.", "It's fine."), all), ["orders-api"])
    assert.deepStrictEqual(shortlist(t("orders-db?", "a", "b", "It's fine."), all), all) // three turns back is too far
    assert.deepStrictEqual(shortlist(t("It's fine."), all), all)
  })
})

describe("route rule", () => {
  const pick = (label: string, confidence: number) => Option.some({ label, confidence, probabilities: {} })
  const base = { claim: 0.9, layers: {}, asserted: "healthy", resource: pick("orders-db", 1), check: pick("db_health", 0.8) }

  it("fires on a claim with a known resource and check, at min confidence >= T_ROUTE", () => {
    const r = decide(base)
    assert.strictEqual(r.action, "check")
    assert.deepStrictEqual([r.check, r.resource], [Option.some("db_health"), Option.some("orders-db")])
    assert.strictEqual(decide({ ...base, check: pick("db_health", T_ROUTE) }).action, "check")
  })

  it("escalates a claim it cannot route, and ignores what is not a claim", () => {
    assert.strictEqual(decide({ ...base, check: pick("db_health", T_ROUTE - 0.01) }).action, "escalate")
    assert.strictEqual(decide({ ...base, check: pick("none", 0.9) }).action, "escalate")
    assert.strictEqual(decide({ ...base, resource: pick("unknown", 0.9) }).action, "escalate")
    const ignored = decide({ ...base, claim: 0.49 })
    assert.strictEqual(ignored.action, "ignore")
    assert.isTrue(Option.isNone(ignored.check))
  })

  it("averages rotated answers before picking", () => {
    // order bias: each rotation favours its first option a little
    const p = average([
      { label: "a", probabilities: { a: 0.5, b: 0.3, c: 0.2 } },
      { label: "b", probabilities: { b: 0.5, c: 0.1, a: 0.4 } }
    ])
    assert.strictEqual(p.label, "a")
    assert.closeTo(p.confidence, (3 * 0.45 - 1) / 2, 1e-12)
  })
})

describe("route (Decider calls)", () => {
  const ask = (turns: ReadonlyArray<Turn>) =>
    Effect.gen(function*() {
      const inventory = yield* (yield* CheckSource).inventory
      const r = yield* route(turns, inventory)
      const calls = yield* (yield* ScriptedDecider).calls
      return { r, calls }
    })
  const lines = scripted({
    "The orders DB is fine.": { claim: 0.9, asserted: "healthy", check: "db_health" },
    "It's fine, CPU is normal.": { claim: 0.9, asserted: "healthy", resource: "orders-db", check: "db_health" },
    "Let's look at the orders database first.": { claim: 0.1 }
  })
  const layer = Layer.mergeAll(lines, MockSource.layer())

  it.effect("when code finds the resource, asks only its checks after the claim", () =>
    Effect.gen(function*() {
      const { r, calls } = yield* ask([["Sam", "The orders DB is fine."]])
      assert.strictEqual(r.action, "check")
      assert.deepStrictEqual(r.resource, Option.some("orders-db"))
      assert.strictEqual(calls.length, 2) // claim layers + asserted state; then the check
      assert.deepStrictEqual(Object.keys(calls[0]!.questions), ["short", "fact", "status", "hedge", "a0", "a1"])
      // all rotations of the resource's own checks, plus none
      assert.deepStrictEqual(Object.keys(calls[1]!.questions), ["c0_0", "c0_1", "c0_2"])
      assert.deepStrictEqual(Object.keys((calls[1]!.questions.c0_1 as { criteria: object }).criteria), ["alarm_state", "none", "db_health"])
    }).pipe(Effect.provide(layer)))

  it.effect("asks for the resource from context, with each candidate's checks", () =>
    Effect.gen(function*() {
      const { r, calls } = yield* ask([["Priya", "Let's look at the orders database first."], ["Jordan", "It's fine, CPU is normal."]])
      assert.strictEqual(r.action, "check")
      assert.deepStrictEqual([r.resource, r.check], [Option.some("orders-db"), Option.some("db_health")])
      assert.strictEqual(calls.length, 2)
      const routing = calls[1]!
      assert.deepStrictEqual(Object.keys(routing.questions), ["r0", "r1", "c0_0", "c0_1", "c0_2"])
      assert.deepStrictEqual(Object.keys((routing.questions.r0 as { criteria: object }).criteria), ["orders-db", "unknown"])
      assert.include(routing.state as string, "previous_turns: Priya: Let's look at the orders database first.")
    }).pipe(Effect.provide(layer)))

  it.effect("stops after one request when it is not a claim", () =>
    Effect.gen(function*() {
      const { r, calls } = yield* ask([["Priya", "What are we seeing?"]])
      assert.strictEqual(r.action, "ignore")
      assert.strictEqual(calls.length, 1)
    }).pipe(Effect.provide(layer)))
})
