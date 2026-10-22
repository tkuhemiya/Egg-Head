import { Agent, Model } from "@strands-agents/sdk"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { type AgentFactory, type AgentLike, BedrockSupport, checkTool, RouteChoice, SpeakGuard } from "../src/Bedrock.ts"
import { CheckSource, MockSource } from "../src/Checks.ts"
import type { LedgerItem } from "../src/Ledger.ts"

const ITEM: LedgerItem = {
  speaker: "Sam",
  claim: "The DB is fine",
  check: "db_health",
  resource: "orders-db",
  status: "degraded",
  evidence: "CPU 98% for the last 6 min; alarm OrdersDB-CPU in ALARM",
  turn: 0,
  raised: false
}

/** Records prompts; answers with fixed text or structured output. */
const fakeAgent = (reply: { text?: string; structured?: RouteChoice }) => {
  const prompts: Array<string> = []
  const agent: AgentLike = {
    invoke: async (prompt) => {
      prompts.push(prompt)
      return { toString: () => reply.text ?? "", structuredOutput: reply.structured }
    }
  }
  return { prompts, factory: (() => agent) satisfies AgentFactory }
}

const support = (factory: AgentFactory) =>
  Effect.provide(Layer.provideMerge(BedrockSupport.layer({ agentFactory: factory }), MockSource.layer()))

/** A Strands model that counts calls and always answers with one text message. */
class CountingModel extends Model {
  calls = 0
  updateConfig() {}
  getConfig() {
    return { modelId: "counting" }
  }
  async *stream() {
    this.calls++
    yield { type: "modelMessageStartEvent" as const, role: "assistant" as const }
    yield { type: "modelContentBlockStartEvent" as const }
    yield { type: "modelContentBlockDeltaEvent" as const, delta: { type: "textDelta" as const, text: "Quick flag." } }
    yield { type: "modelContentBlockStopEvent" as const }
    yield { type: "modelMessageStopEvent" as const, stopReason: "endTurn" as const }
  }
}

describe("SpeakGuard on a real Strands agent", () => {
  it.live("a closed gate denies the model call: Bedrock is never reached", () =>
    Effect.promise(async () => {
      const model = new CountingModel()
      const closed = new Agent({ model, interventions: [new SpeakGuard(() => "min_silence")], printer: false })
      const result = await closed.invoke("say it")
      assert.strictEqual(model.calls, 0)
      assert.include(String(result), "min_silence")

      const open = new Agent({ model, interventions: [new SpeakGuard(() => null)], printer: false })
      assert.strictEqual(String(await open.invoke("say it")).trim(), "Quick flag.")
      assert.strictEqual(model.calls, 1)
    }))
})

describe("BedrockSupport", () => {
  it.effect("writes from a prompt with the evidence, and counts calls", () => {
    const fake = fakeAgent({ text: " Quick flag, orders-db CPU is 98%. " })
    return Effect.gen(function*() {
      const s = yield* BedrockSupport
      assert.strictEqual(yield* s.write(ITEM), "Quick flag, orders-db CPU is 98%.")
      assert.include(fake.prompts[0], "CPU 98%")
      assert.deepStrictEqual(yield* s.calls, { write: 1, route: 0 })
    }).pipe(support(fake.factory))
  })

  it.effect("accepts only known checks and resources from the escalation route", () =>
    Effect.gen(function*() {
      const good = fakeAgent({ structured: { checkable: true, check: "db_health", resource: "orders-db", asserted: "healthy" } })
      const r = yield* Effect.flatMap(BedrockSupport, (s) => s.route([["Sam", "The DB is fine"]])).pipe(support(good.factory))
      assert.deepStrictEqual(
        [r.action, r.check, r.resource, r.asserted],
        ["check", Option.some("db_health"), Option.some("orders-db"), Option.some("healthy")]
      )
      assert.include(good.prompts[0], "Call so far (last line is LATEST):\nSam: The DB is fine")

      const bad = fakeAgent({ structured: { checkable: true, check: "made_up", resource: "orders-db" } })
      const ignored = yield* Effect.flatMap(BedrockSupport, (s) => s.route([["Sam", "x"]])).pipe(support(bad.factory))
      assert.strictEqual(ignored.action, "ignore")
    }))

  it.effect("interrupting the fiber aborts the Bedrock call", () => {
    let aborted = false
    const slow: AgentFactory = () => ({
      invoke: (_prompt, options) =>
        new Promise((_resolve, reject) => {
          options?.cancelSignal?.addEventListener("abort", () => {
            aborted = true
            reject(new Error("cancelled"))
          })
        })
    })
    return Effect.gen(function*() {
      const s = yield* BedrockSupport
      const fiber = yield* Effect.forkChild(s.write(ITEM))
      yield* TestClock.adjust("1 second")
      yield* Fiber.interrupt(fiber)
      assert.isTrue(aborted)
    }).pipe(support(slow))
  })

  it.effect("check tool runs the source", () =>
    Effect.gen(function*() {
      const source = yield* CheckSource
      const t = checkTool(source, Effect.runPromise)
      const out = yield* Effect.promise(() => t.invoke({ check: "db_health", resource: "orders-db" }))
      assert.include(String(out), "degraded")
      const none = yield* Effect.promise(() => t.invoke({ check: "queue_depth", resource: "orders-db" }))
      assert.include(String(none), "does not apply")
    }).pipe(Effect.provide(MockSource.layer())))
})
