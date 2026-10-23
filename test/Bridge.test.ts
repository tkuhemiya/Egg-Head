import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import type { DecisionModel } from "effect/ai"
import { TestClock } from "effect/testing"
import { Bridge, Event } from "../src/runtime/Bridge.ts"
import { MockSource } from "../src/domain/Checks.ts"
import { ScriptedDecider, type SystemOneAnswer } from "../src/runtime/Decider.ts"
import { COOLDOWN_S } from "../src/domain/Gate.ts"
import { Writer } from "../src/domain/Speaker.ts"
import { type Line, scripted } from "./helpers.ts"

const layerFor = (decider: Layer.Layer<ScriptedDecider | DecisionModel.DecisionModel>) =>
  Bridge.layer.pipe(Layer.provideMerge(Layer.mergeAll(decider, MockSource.layer(), Writer.template)))
const layer = (lines: Readonly<Record<string, Line>>) => layerFor(scripted(lines))

const falseDb: Line = { claim: 0.9, asserted: "healthy", check: "db_health" } // orders DB is in the line
const falseDeploy: Line = { claim: 0.9, asserted: "unchanged", check: "recent_deploys" }

describe("Bridge", () => {
  it.effect("waits out the cooldown before speaking again (Clock, not wall time)", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      yield* bridge.hear("Sam", "The orders DB is fine, it's the API.", 0.4)
      const first = yield* bridge.hear("Priya", "Okay, the API then.", 1.6)
      assert.isTrue(Option.isSome(first.said))

      yield* bridge.hear("Jordan", "We didn't deploy orders-api.", 0.4)
      const early = yield* bridge.hear("Priya", "Right.", 1.6)
      assert.deepStrictEqual(Option.flatMap(early.gate, (g) => g.blockedBy), Option.some("cooldown"))

      yield* TestClock.adjust(`${COOLDOWN_S} seconds`)
      const later = Option.getOrThrow(yield* bridge.tick(1.6))
      assert.isTrue(Option.isSome(later.said))
    }).pipe(Effect.provide(layer({
      "The orders DB is fine, it's the API.": falseDb,
      "We didn't deploy orders-api.": falseDeploy
    }))))

  it.effect("broadcasts every decision on `changes`", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const seen = yield* Stream.take(bridge.changes, 2).pipe(Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      yield* bridge.hear("Priya", "What are we seeing?", 0.5)
      yield* bridge.hear("Sam", "The orders DB is fine, it's the API.", 0.4)
      const events = yield* Fiber.join(seen)
      assert.deepStrictEqual(Array.from(events, (e) => e.speaker), ["Priya", "Sam"])
    }).pipe(Effect.provide(layer({ "The orders DB is fine, it's the API.": falseDb }))))

  it.effect("serialises concurrent utterances: turns in order, one utterance at a time", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const texts = ["a", "b", "c", "d"]
      yield* Effect.forEach(texts, (t) => bridge.hear("X", t, 0.5), { concurrency: "unbounded" })
      const s = yield* bridge.state
      assert.deepStrictEqual(s.events.map((e) => e.turn), [0, 1, 2, 3])
      assert.deepStrictEqual(new Set(s.turns.map(([, t]) => t)), new Set(texts))
      // each utterance's requests name it as the latest line, in the order heard
      const latest = (yield* (yield* ScriptedDecider).calls).map((c) => /latest_utterance: (.*)/.exec(String(c.state))![1])
      assert.deepStrictEqual([...new Set(latest)], s.turns.map(([, t]) => t))
    }).pipe(Effect.provide(layer({}))))

  it.effect("asks the gate questions only while a claim is open", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      yield* bridge.hear("Sam", "The orders DB is fine, it's the API.", 0.4)
      const before = (yield* (yield* ScriptedDecider).calls).length
      const ev = yield* bridge.hear("Priya", "Okay.", 1.6)
      const calls = yield* (yield* ScriptedDecider).calls
      assert.isFalse(calls.slice(0, before).some((c) => "rep" in c.questions))
      const gate = calls.slice(before).find((c) => "rep" in c.questions)!
      assert.include(gate.state as string, `Flagged claim (checked by Egg Head, not yet raised): Sam said "The orders DB is fine`)
      assert.include(gate.state as string, "Silence since the latest speaker stopped: 1.6 s")
      assert.deepStrictEqual(Object.keys(ev.gateScores), ["self_repaired", "finished", "finished_raw"])
    }).pipe(Effect.provide(layer({ "The orders DB is fine, it's the API.": falseDb }))))

  it.effect("counts a claim it cannot route as an escalation", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const ev = yield* bridge.hear("Sam", "The DB is fine.", 0.4)
      assert.deepStrictEqual([Option.map(ev.route, (r) => r.action), ev.escalations], [Option.some("escalate"), 1])
    }).pipe(Effect.provide(layer({ "The DB is fine.": { claim: 0.9, asserted: "healthy" } }))))

  it.effect("encodes events as plain JSON for the dashboard", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const ev = yield* bridge.hear("Sam", "The orders DB is fine, it's the API.", 0.4)
      const json = yield* Schema.encodeEffect(Schema.toCodecJson(Event))(ev)
      assert.deepInclude(json as object, { verdict: "contradicts", said: null })
      assert.deepInclude((json as { gate: object }).gate, { blockedBy: "persisted", repairedBy: null })
    }).pipe(Effect.provide(layer({ "The orders DB is fine, it's the API.": falseDb }))))

  it.effect("rejects a Decider answer that breaks the answer contract", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const error = yield* Effect.flip(bridge.hear("Sam", "The orders DB is fine.", 0.4))
      assert.strictEqual(error._tag, "AiError")
    }).pipe(Effect.provide(layerFor(ScriptedDecider.layerWith((request) =>
      Effect.succeed(Object.fromEntries(Object.keys(request.questions).map((k): [string, SystemOneAnswer] =>
        /^[arc][\d_]+$/.test(k)
          ? [k, { type: "choice", choice: "x", probabilities: { x: 0.9 } }] // misses the other options
          : [k, { type: "noul", noul: 0.9 }]
      )))
    )))))
})
