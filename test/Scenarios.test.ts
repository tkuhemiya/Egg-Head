/**
 * Every call in data/calls/ played offline through the real call loop and Bridge, in virtual
 * time, and judged line by line. Adding a file adds a test; there is no list to keep in step.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { decodeCall } from "../src/Call.ts"
import { behaves, record } from "./harness/Offline.ts"

const DIR = new URL("../data/calls/", import.meta.url)
const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()
const load = (file: string) => decodeCall(JSON.parse(readFileSync(new URL(file, DIR), "utf8")))

describe("call scenarios behave as written", () => {
  it("finds the scenarios", () => assert.isAbove(files.length, 1))

  for (const file of files) {
    it.effect(file, () => Effect.flatMap(load(file), (call) => behaves(call)), 30_000)
  }

  it.effect("the demo call gives the same log twice", () =>
    Effect.gen(function*() {
      const call = yield* load("checkout-incident.json")
      const [a, b] = [yield* record(call), yield* record(call)]
      assert.isAbove(a.length, 50)
      assert.deepStrictEqual(a, b)
    }), 30_000)

  it.effect("a typo in a scenario fails at decode", () =>
    Effect.gen(function*() {
      const line = { speaker: "Sam", text: "The orders DB is fine.", pause: 0.4 }
      const bad = (l: object) => decodeCall({ title: "t", voices: {}, lines: [{ ...line, ...l }] }).pipe(Effect.exit)
      assert.isTrue(Exit.isSuccess(yield* bad({ decider: { claim: 0.9, check: "db_health" } })))
      assert.isTrue(Exit.isFailure(yield* bad({ decider: { clam: 0.9 } })))
      assert.isTrue(Exit.isFailure(yield* bad({ decider: { check: "db_heath" } })))
      assert.isTrue(Exit.isFailure(yield* bad({ decider: { claim: 9 } })))
      assert.isTrue(Exit.isFailure(yield* bad({ expect: [{ _tag: "Says", kind: "shout" }] })))
      assert.isTrue(Exit.isFailure(yield* bad({ expect: [{ _tag: "Says", kind: "ack", when: { since: "lineEnd", minS: 3, maxS: 2 } }] })))
    }))
})
