import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { Bridge, type Event } from "../src/runtime/Bridge.ts"
import { MockSource } from "../src/domain/Checks.ts"
import * as C from "../src/domain/Conversation.ts"
import { Investigator } from "../src/runtime/Investigator.ts"
import { SupportError, Writer } from "../src/domain/Speaker.ts"
import { type Line, scripted } from "./helpers.ts"

/** Bridge with an Investigator that answers from the mock world (no model). */
const layer = (lines: Readonly<Record<string, Line>>, investigator = Investigator.direct) =>
  Bridge.layer.pipe(
    Layer.provideMerge(investigator),
    Layer.provideMerge(Layer.mergeAll(scripted(lines), MockSource.layer(), Writer.template))
  )

/** Let background Investigator jobs finish. */
const settle = Effect.gen(function*() {
  for (let i = 0; i < 50; i++) yield* Effect.yieldNow
})

const said = (evs: ReadonlyArray<Option.Option<Event> | Event>) =>
  evs.flatMap((e) => {
    const ev = Option.isOption(e) ? Option.getOrUndefined(e) : e
    return ev && Option.isSome(ev.said) ? [[ev.saidKind, ev.said.value] as const] : []
  })

const falseDb: Line = { claim: 0.9, asserted: "healthy", check: "db_health" }
const NOT_DONE = 0.02 // raw `fin`: Platt-scaled to ~0.11, "not finished"

describe("Conversation rules", () => {
  it("waits on a trailing filler whatever Decider says, and replies after long silence", () => {
    assert.isFalse(C.readyToReply({ finishedP: 0.9, text: "Egg Head, can you check the, uh…", silenceS: 1.6 }).ready)
    assert.isTrue(C.readyToReply({ finishedP: 0.9, text: "the checkout queue? How backed up is it?", silenceS: 0.6 }).ready)
    assert.isFalse(C.readyToReply({ finishedP: 0.2, text: "How backed up is it?", silenceS: 1.5 }).ready)
    assert.isTrue(C.readyToReply({ finishedP: 0.2, text: "How backed up is", silenceS: C.REPLY_MAX_WAIT_S }).ready)
  })

  it("writes short lines in code", () => {
    assert.strictEqual(C.answerLine("Priya", "The checkout queue has 12,400 messages"), "Priya, the checkout queue has 12,400 messages.")
    assert.strictEqual(C.flagLine("Sam", "orders-db: CPU 98%"), "Quick flag, Sam: orders-db: CPU 98%.")
  })
})

describe("Bridge with an Investigator", () => {
  it.effect("confirms a false claim with the Investigator, then flags it at the gap", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      yield* bridge.hear("Sam", "The orders DB is fine, CPU is normal.", 0.3)
      let s = yield* bridge.state
      assert.strictEqual(s.ledger[0]!.agent, "pending") // no model call yet
      const next = yield* bridge.hear("Priya", "Okay, so let's focus on the API then.", 0.3)
      assert.strictEqual(next.agent?.action, "dispatched")
      yield* settle
      s = yield* bridge.state
      assert.strictEqual(s.ledger[0]!.agent, "confirmed")
      const spoken = said([yield* bridge.tick(1.4)])
      assert.deepStrictEqual(spoken, [["flag", "Quick flag, Sam: orders-db is degraded, CPU 98% for the last 6 min; alarm OrdersDB-CPU in ALARM."]])
    }).pipe(Effect.provide(layer({ "The orders DB is fine, CPU is normal.": falseDb }))))

  it.effect("spends no model call on a claim the call corrects first", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      yield* bridge.hear("Lee", "We didn't deploy orders-api today.", 0.3)
      const ev = yield* bridge.hear("Mei", "Hold on, are you sure? I think v2.14 went out this morning.", 0.3)
      assert.isUndefined(ev.agent)
      assert.match(ev.note ?? "", /before any LLM call/)
      const s = yield* bridge.state
      assert.strictEqual(s.tasks, 0)
      assert.deepStrictEqual(said([yield* bridge.tick(2)]), [])
    }).pipe(Effect.provide(layer({ "We didn't deploy orders-api today.": { claim: 0.9, asserted: "unchanged", check: "recent_deploys" } }))))

  it.effect("marks a crashed Investigator job failed instead of leaving it running", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      yield* bridge.hear("Sam", "The orders DB is fine, CPU is normal.", 0.3)
      yield* bridge.hear("Priya", "Okay, so let's focus on the API then.", 0.3)
      yield* settle
      const s = yield* bridge.state
      assert.isTrue(s.events.some((e) => e.agent?.action === "failed"), "JobDone must project the failed job, not only the fallback dispatch")
    }).pipe(Effect.provide(layer(
      { "The orders DB is fine, CPU is normal.": falseDb },
      Layer.succeed(Investigator, Investigator.of({
        name: "stub",
        confirm: () => Effect.fail(new SupportError({ operation: "investigate", cause: "no model" })),
        answer: () => Effect.fail(new SupportError({ operation: "investigate", cause: "no model" }))
      }))
    ))))

  it.effect("stays quiet when the Investigator finds the claim was right", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      yield* bridge.hear("Sam", "The orders DB is fine, CPU is normal.", 0.3)
      yield* bridge.hear("Priya", "Okay.", 0.3)
      yield* settle
      const s = yield* bridge.state
      assert.strictEqual(s.ledger[0]!.agent, "overruled")
      assert.deepStrictEqual(said([yield* bridge.tick(2)]), [])
    }).pipe(Effect.provide(layer(
      { "The orders DB is fine, CPU is normal.": falseDb },
      Layer.succeed(Investigator, Investigator.of({
        name: "stub",
        confirm: () => Effect.succeed({ status: "healthy", fact: "orders-db CPU 30%", by: "stub" }),
        answer: () => Effect.succeed("")
      }))
    ))))

  it.effect("waits for the person speaking to it to finish, acknowledges, then answers", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const first = yield* bridge.hear("Priya", "Egg Head, can you check the, uh…", 0.3)
      assert.strictEqual(first.request?.state, "listening")
      const pause = [yield* bridge.tick(0.6), yield* bridge.tick(1.6)]
      assert.deepStrictEqual(said(pause), []) // a silence-only end-of-turn rule would have replied here
      assert.match(Option.getOrThrow(pause[1]!).note ?? "", /has not finished/)
      yield* bridge.hear("Priya", "the checkout queue? How backed up is it?", 0.3)
      const ackEv = yield* bridge.tick(0.6)
      const ack = said([ackEv])
      assert.deepStrictEqual(ack, [["ack", "On it, Priya."]])
      assert.strictEqual(yield* bridge.pending, 1)
      const ackSpeech = Option.flatMap(ackEv, (e) => e.speech ?? Option.none())
      if (Option.isSome(ackSpeech)) yield* bridge.spoke(ackSpeech.value.id)
      yield* TestClock.adjust("3 seconds")
      yield* settle
      const answer = said([yield* bridge.tick(3.1)])
      assert.deepStrictEqual(answer, [["answer", "Priya, checkout-queue: 12,400 visible messages (normal < 100)."]])
      assert.strictEqual(yield* bridge.pending, 0)
    }).pipe(Effect.provide(layer({
      "Egg Head, can you check the, uh…": { addr: 0.9, fin: NOT_DONE },
      "the checkout queue? How backed up is it?": { fin: 0.5 }
    }))))

  it.effect("takes a question the call leaves hanging, and stays out when someone answers", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      yield* bridge.hear("Priya", "What are we seeing on the orders API?", 0.3)
      yield* bridge.hear("Jordan", "Orders API is throwing a lot of 500s.", 0.3)
      let s = yield* bridge.state
      assert.strictEqual(s.requests[0]!.state, "dropped")
      yield* bridge.hear("Lee", "Did anyone push anything to the payments API today?", 0.3)
      assert.deepStrictEqual(said([yield* bridge.tick(1.5)]), []) // give the call a chance
      const takeEv = yield* bridge.tick(2.6)
      assert.deepStrictEqual(said([takeEv]), [["ack", C.OPEN_ACK]])
      const takeSpeech = Option.flatMap(takeEv, (e) => e.speech ?? Option.none())
      if (Option.isSome(takeSpeech)) yield* bridge.spoke(takeSpeech.value.id)
      yield* TestClock.adjust("3 seconds")
      yield* settle
      assert.deepStrictEqual(said([yield* bridge.tick(3.1)]), [["answer", "Lee, payments-api: last deploy 9 days ago."]])
      s = yield* bridge.state
      assert.deepStrictEqual(s.requests.map((r) => r.state), ["dropped", "answered"])
    }).pipe(Effect.provide(layer({
      "What are we seeing on the orders API?": { ask: 0.9 },
      "Orders API is throwing a lot of 500s.": { claim: 0.9, asserted: "degraded", check: "service_error_rate" },
      "Did anyone push anything to the payments API today?": { ask: 0.9 }
    }))))

  it.effect("does not barge while Egg Head is already speaking", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      yield* bridge.hear("Jordan", "The payments API is erroring too, that's the real problem.", 0.3)
      yield* bridge.hear("Priya", "Egg Head, can you check the checkout queue?", 0.3)
      const ackEv = yield* bridge.tick(0.6)
      assert.deepStrictEqual(said([ackEv]), [["ack", "On it, Priya."]])
      const whileSpeaking = yield* bridge.partial("Lee", "Jordan, restart the payments API now")
      assert.deepStrictEqual(said([whileSpeaking]), [])
      const ackSpeech = Option.flatMap(ackEv, (e) => e.speech ?? Option.none())
      if (Option.isSome(ackSpeech)) yield* bridge.spoke(ackSpeech.value.id)
      const barge = yield* bridge.partial("Lee", "Jordan, restart the payments API now")
      assert.strictEqual(said([barge])[0]?.[0], "barge")
    }).pipe(Effect.provide(layer({
      "The payments API is erroring too, that's the real problem.": { claim: 0.9, asserted: "degraded", check: "service_error_rate" },
      "Egg Head, can you check the checkout queue?": { addr: 0.9, fin: 0.5 },
      "Jordan, restart the payments API now": { act: 0.9 }
    }))))

  it.effect("barges in when someone is about to act on a wrong claim, not on a mere mention", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      yield* bridge.hear("Jordan", "The payments API is erroring too, that's the real problem.", 0.3)
      assert.isTrue(Option.isNone(yield* bridge.partial("Priya", "Jordan")))
      const mention = yield* bridge.partial("Priya", "The payments API")
      assert.deepStrictEqual(said([mention]), []) // asked Decider: not an instruction
      const barge = yield* bridge.partial("Priya", "Jordan, restart the payments API now")
      assert.deepStrictEqual(said([barge]), [["barge", "Sorry to cut in, Priya: my quick check shows payments-api is healthy, 5xx rate 0.3%. I'm double-checking."]])
      const s = yield* bridge.state
      assert.isTrue(s.ledger[0]!.raised)
    }).pipe(Effect.provide(layer({
      "The payments API is erroring too, that's the real problem.": { claim: 0.9, asserted: "degraded", check: "service_error_rate" },
      "Jordan, restart the payments API now": { act: 0.9 }
    }))))
})
