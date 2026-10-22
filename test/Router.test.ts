import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import { compare, inferAsserted } from "../src/Compare.ts"
import type { RoutingAnswers } from "../src/Questions.ts"
import { confidence, route } from "../src/Router.ts"
import { choice, ignored, routed } from "./helpers.ts"

// Decider wire answers -> the DecisionModel answer shape the router reads.
const asAnswers = (raw: ReturnType<typeof routed>): RoutingAnswers => {
  const cls = (a: (typeof raw)["which_check"]) => {
    if (a.type !== "choice") throw new Error("expected a choice")
    return { label: a.choice, probabilities: a.probabilities, confidence: a.confidence }
  }
  if (raw.is_claim.type !== "noul") throw new Error("expected a noul")
  return {
    is_claim: { probability: raw.is_claim.noul },
    which_check: cls(raw.which_check),
    which_resource: cls(raw.which_resource),
    asserted_state: cls(raw.asserted_state)
  }
}

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

describe("route", () => {
  it("fires, escalates or ignores on the weakest score", () => {
    const fired = route(asAnswers(routed("db_health", "orders-db", "healthy")))
    assert.strictEqual(fired.action, "check")
    assert.deepStrictEqual([fired.check, fired.resource], [Option.some("db_health"), Option.some("orders-db")])

    const mid = routed("db_health", "orders-db", "healthy")
    mid.which_resource = choice("which_resource", "orders-db", 0.6, 0.6)
    assert.strictEqual(route(asAnswers(mid)).action, "escalate")

    const none = route(asAnswers(ignored()))
    assert.strictEqual(none.action, "ignore")
    assert.isTrue(Option.isNone(none.check))
  })

  it("recomputes choice confidence when a provider leaves it out", () => {
    // (N·p_max − 1)/(N − 1) with N = 4, p_max = 0.7
    assert.closeTo(confidence({ label: "a", probabilities: { a: 0.7, b: 0.1, c: 0.1, d: 0.1 } }), 0.6, 1e-12)
  })
})
