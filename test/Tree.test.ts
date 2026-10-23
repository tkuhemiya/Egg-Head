import { describe, expect, it } from "vitest"
import { inspectNode, trace } from "../demo/web/tree.js"

const line = (route: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  speaker: "Jordan",
  events: [{ speaker: "Jordan", turn: 0, route, deciderMs: 100, gateScores: {}, ...extra }]
})

describe("the dashboard tree", () => {
  it("hangs just talk off the three nos, not off line-heard", () => {
    expect(inspectNode("nothing")?.parent).toBe("open")
    expect(inspectNode("open")?.parent).toBe("addressed")
    expect(inspectNode("addressed")?.parent).toBe("claim")
    expect(inspectNode("claim")?.parent).toBe("heard")
  })

  it("walks claim no → addressed no → question no → just talk", () => {
    const path = trace({ requests: new Map() }, line({ action: "ignore", scores: { claim: 0.12 } }))
    expect([...path].map(([id, p]) => [id, p.state])).toEqual([
      ["heard", "yes"],
      ["claim", "no"],
      ["addressed", "no"],
      ["open", "no"],
      ["nothing", "quiet"]
    ])
  })

  it("does not light just talk on a claim", () => {
    const path = trace({ requests: new Map(), claims: new Map(), tasks: new Map() }, line(
      { action: "check", resource: "orders-api", check: "service_error_rate", scores: { claim: 0.9 } },
      { verdict: "supports", checkEvidence: "ok" }
    ))
    expect(path.has("nothing")).toBe(false)
    expect(path.has("addressed")).toBe(false)
    expect(path.get("true")?.state).toBe("quiet")
  })
})
