import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import * as G from "../src/domain/Gate.ts"

const inp = (kw: Partial<G.GateInput> = {}): G.GateInput => ({
  check: "db_health",
  status: "degraded",
  laterTurns: ["Okay, let's focus on the API."],
  silenceS: 1.6,
  selfRepairedP: 0.2,
  interruptP: 0.2,
  ...kw
})

describe("SpeakGate", () => {
  it("speaks on a contradicted DB claim in a gap", () => {
    const d = G.decide(inp())
    assert.isTrue(d.speak)
    assert.strictEqual(G.LEVELS[d.costLevel], "high")
  })

  it("needs the claim to persist one turn", () => {
    assert.deepStrictEqual(G.decide(inp({ laterTurns: [] })).blockedBy, Option.some("persisted"))
  })

  it("blocks on keyword repair", () => {
    for (const text of ["Wait Sam, orders-db is at 98", "Hold on, it spiked", "Are you sure?", "Sam, how sure are you?"]) {
      const d = G.decide(inp({ laterTurns: [text] }))
      assert.deepStrictEqual([d.blockedBy, d.repairedBy], [Option.some("not_repaired"), Option.some("keyword")], text)
    }
  })

  it("does not count agreement as repair", () => {
    assert.isTrue(G.decide(inp({ laterTurns: ["Agreed, DB looks okay from here too."] })).speak)
  })

  it("is repaired by a later true claim", () => {
    assert.deepStrictEqual(G.decide(inp({ laterClaimSupportsCheck: true })).repairedBy, Option.some("ledger"))
  })

  it("never talks over a live voice", () => {
    assert.deepStrictEqual(G.decide(inp({ silenceS: 0.1, interruptP: 0.0 })).blockedBy, Option.some("min_silence"))
  })

  it("opens the floor on a Decider gap or a long silence", () => {
    assert.deepStrictEqual(G.decide(inp({ silenceS: 0.8, interruptP: 0.9 })).blockedBy, Option.some("floor_open"))
    assert.isTrue(G.decide(inp({ silenceS: 3.0, interruptP: 0.9 })).speak)
    assert.isTrue(G.decide(inp({ silenceS: 0.8, interruptP: 0.3 })).speak)
  })

  it("does not interrupt for a parked topic", () => {
    const d = G.decide(inp({ check: "service_error_rate", laterTurns: ["Auth isn't in the checkout path, let's park that."] }))
    assert.deepStrictEqual([d.blockedBy, G.LEVELS[d.costLevel]], [Option.some("worth_it"), "low"])
  })

  it("raises cost for down, and an alarm list is moderate", () => {
    assert.strictEqual(G.costLevel(inp({ check: "latency_p99", status: "down" })), 3)
    assert.strictEqual(G.costLevel(inp({ check: "alarm_state" })), 2)
  })

  it("respects the cooldown", () => {
    assert.deepStrictEqual(G.decide(inp({ secondsSinceLastSpoke: 5 })).blockedBy, Option.some("cooldown"))
  })
})
