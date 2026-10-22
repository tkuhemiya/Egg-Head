import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { Bridge, Event } from "../src/Bridge.ts"
import { MockSource } from "../src/Checks.ts"
import { ScriptedDecider, type SystemOneAnswer } from "../src/Decider.ts"
import { COOLDOWN_S } from "../src/Gate.ts"
import { Writer } from "../src/Speaker.ts"
import { ignored, policy, routed } from "./helpers.ts"

const layer = (batches: ReadonlyArray<Record<string, SystemOneAnswer>>) =>
  Bridge.layer.pipe(Layer.provideMerge(Layer.mergeAll(ScriptedDecider.layer(batches), MockSource.layer(), Writer.template)))

const falseDb = routed("db_health", "orders-db", "healthy")
const falseDeploy = routed("recent_deploys", "orders-api", "unchanged")

describe("Bridge", () => {
  it.effect("waits out the cooldown before speaking again (Clock, not wall time)", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      yield* bridge.hear("Sam", "The DB is fine, it's the API.", 0.4)
      const first = yield* bridge.hear("Priya", "Okay, the API then.", 1.6)
      assert.isTrue(Option.isSome(first.said))

      yield* bridge.hear("Jordan", "We didn't deploy anything.", 0.4)
      const early = yield* bridge.hear("Priya", "Right.", 1.6)
      assert.deepStrictEqual(Option.flatMap(early.gate, (g) => g.blockedBy), Option.some("cooldown"))

      yield* TestClock.adjust(`${COOLDOWN_S} seconds`)
      const later = Option.getOrThrow(yield* bridge.tick(1.6))
      assert.isTrue(Option.isSome(later.said))
    }).pipe(Effect.provide(layer([
      falseDb,
      { ...ignored(), ...policy() },
      { ...falseDeploy, ...policy() },
      { ...ignored(), ...policy() }
    ]))))

  it.effect("broadcasts every decision on `changes`", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const seen = yield* Stream.take(bridge.changes, 2).pipe(Stream.runCollect, Effect.forkChild)
      yield* Effect.yieldNow
      yield* bridge.hear("Priya", "What are we seeing?", 0.5)
      yield* bridge.hear("Sam", "The DB is fine, it's the API.", 0.4)
      const events = yield* Fiber.join(seen)
      assert.deepStrictEqual(Array.from(events, (e) => e.speaker), ["Priya", "Sam"])
    }).pipe(Effect.provide(layer([ignored(), falseDb]))))

  it.effect("serialises concurrent utterances: one Decider batch at a time, turns in order", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const texts = ["a", "b", "c", "d"]
      yield* Effect.forEach(texts, (t) => bridge.hear("X", t, 0.5), { concurrency: "unbounded" })
      const s = yield* bridge.state
      assert.deepStrictEqual(s.events.map((e) => e.turn), [0, 1, 2, 3])
      assert.deepStrictEqual(new Set(s.turns.map(([, t]) => t)), new Set(texts))
      assert.strictEqual((yield* (yield* ScriptedDecider).calls).length, 4)
    }).pipe(Effect.provide(layer([ignored(), ignored(), ignored(), ignored()]))))

  it.effect("sends the routing questions only, until a claim is open", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      yield* bridge.hear("Sam", "The DB is fine, it's the API.", 0.4)
      yield* bridge.hear("Priya", "Okay.", 1.6)
      const [first, second] = yield* (yield* ScriptedDecider).calls
      assert.deepStrictEqual(Object.keys(first!.questions), ["is_claim", "which_check", "which_resource", "asserted_state"])
      assert.include(Object.keys(second!.questions), "floor_free")
      assert.include(second!.state as string, "Flagged claim (already checked by Egg Head")
    }).pipe(Effect.provide(layer([falseDb, { ...ignored(), ...policy() }]))))

  it.effect("encodes events as plain JSON for the dashboard", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const ev = yield* bridge.hear("Sam", "The DB is fine, it's the API.", 0.4)
      const json = yield* Schema.encodeEffect(Schema.toCodecJson(Event))(ev)
      assert.deepInclude(json as object, { verdict: "contradicts", said: null })
      assert.deepInclude((json as { gate: object }).gate, { blockedBy: "persisted", repairedBy: null })
    }).pipe(Effect.provide(layer([falseDb]))))

  it.effect("rejects a Decider batch that breaks the answer contract", () =>
    Effect.gen(function*() {
      const bridge = yield* Bridge
      const error = yield* Effect.flip(bridge.hear("Sam", "The DB is fine.", 0.4))
      assert.strictEqual(error._tag, "AiError")
    }).pipe(Effect.provide(layer([{ ...falseDb, which_check: { type: "choice", choice: "db_health", probabilities: { db_health: 0.9 } } }]))))
})
