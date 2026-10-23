/**
 * Caller's view in tests. Two layers of test, both new:
 *
 * 1. Core is pure, so the review findings replay as plain function tests: a list of inputs,
 *    a clock, and assertions on state. No Effect runtime, no settle loops, no TestClock.
 * 2. Scenarios (data/calls/*.json, test/Scenarios.test.ts) play the same paths through the real
 *    loop; the expectations use the new typed fields (certainty, basis, recheck, Closes).
 */
import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"
import * as Core from "../src/Core.ts"
import type { Event } from "../src/Event.ts"
import { DEFAULTS as T } from "../src/Tuning.ts"

/** Fold inputs through Core.reduce, feeding each `then` back with a scripted slow result. */
declare const play: (inputs: ReadonlyArray<readonly [number, Core.Input]>, mode: Core.Mode, slow?: Slow) => {
  readonly state: Core.State
  readonly events: ReadonlyArray<Event>
}
declare type Slow = { readonly observe?: (turn: number) => Core.Input; readonly act?: number; readonly write?: string }
declare const utter: (speaker: string, text: string, silenceS?: number) => Core.Input
declare const falseDbObserved: (turn: number) => Core.Input
declare const jobDone: (id: number, outcome: "wrong" | "right" | "unknown" | "failed") => Core.Input
declare const saidOf: (events: ReadonlyArray<Event>) => ReadonlyArray<readonly [string, string | null]> // [kind, certainty]

describe("barge-in (owner decision 1)", () => {
  it("is tentative while the second look runs, and the look's result decides the follow-up", () => {
    const { state, events } = play([
      [0.0, utter("Jordan", "The payments API is erroring too.")],
      [2.0, utter("Mei", "Hmm, the payments API dashboards look quiet.")], // second look queued (job 3)
      [3.0, { _tag: "Partial", speaker: "Priya", text: "Jordan, restart the payments API" }]
    ], Core.AGENT, { observe: falseDbObserved, act: 0.9 })
    assert.deepStrictEqual(saidOf(events), [["barge", "tentative"]])
    assert.strictEqual(state.claims[0]!.status._tag, "Checking") // barged: true

    const after = play([[5.0, jobDone(3, "right")], [5.1, { _tag: "Silence", silenceS: 1.5 }]], Core.AGENT)
    assert.deepStrictEqual(saidOf(after.events).at(-1), ["update", null]) // "I'm double-checking" was honoured
  })

  it("never cuts in on a claim the call corrected", () => {
    const { events } = play([
      [0.0, utter("Jordan", "The payments API is erroring too.")],
      [2.0, utter("Mei", "Actually no, payments API is clean.")], // Reading.corrects -> Closed{corrected}
      [3.0, { _tag: "Partial", speaker: "Priya", text: "Jordan, restart the payments API" }]
    ], Core.AGENT, { observe: falseDbObserved, act: 0.9 })
    assert.deepStrictEqual(saidOf(events), [])
  })

  it("does not exist without an Investigator", () => {
    const { events } = play([[0, utter("Jordan", "The payments API is erroring too.")], [1, { _tag: "Partial", speaker: "Priya", text: "restart the payments API" }]], Core.PLAIN)
    assert.isTrue(events.every((e) => Option.isNone(e.said)))
  })
})

describe("failed or unknown second look (owner decision 2, coordinator addition)", () => {
  it("a failed look re-runs the fast check, and a still-wrong claim is flagged as unconfirmed", () => {
    const { state, events } = play([
      [0, utter("Sam", "The orders DB is fine.")],
      [2, utter("Priya", "Okay, let's focus on the API.")], // confirm job 3
      [2 + T.jobs.confirm + 0.1, { _tag: "Silence", silenceS: 3 }] // Bridge deadline: TimedOut -> recheck job queued
    ], Core.AGENT, { observe: falseDbObserved })
    assert.isTrue(events.some((e) => e.jobs.some((j) => j.kind === "recheck" && j.action === "queued")))
    assert.strictEqual(state.jobs.find((j) => j.kind === "confirm")!.status._tag, "TimedOut")
    // recheck reports "still wrong" -> Confirmed{fastCheck} -> flag, tentative, basis fastCheck
  })

  it("an unknown finding closes the claim quietly with a note", () => {
    const { state, events } = play([[0, utter("Sam", "The orders DB is fine.")], [2, utter("Priya", "Okay.")], [4, jobDone(3, "unknown")]], Core.AGENT, { observe: falseDbObserved })
    assert.deepStrictEqual(state.claims[0]!.status, { _tag: "Closed", why: "unsettled", by: "scripted" })
    assert.isTrue(events.every((e) => Option.isNone(e.said)))
  })
})

describe("one line per gap (owner decision 3)", () => {
  it("an answer waits for Egg Head's flag to finish and a few seconds of quiet, but not for the cooldown", () => {
    // flag at t=10 (utterance 7), Ready answer at t=10.2; finished(7) at t=13; next tick at 13.5 holds ("gap");
    // tick at 15.1 (quietS 2.0 after 13) says the answer, 5 s after the flag: the 30 s cooldown did not hold it.
  })
})

describe("parking (owner decision 4)", () => {
  it("closes only the open claims about the parked resource", () => {
    // claims on auth-service and orders-db; "Auth isn't in the checkout path, let's park that."
    // -> event.closes = [{ why: "parked", resource: "auth-service", claims: [1] }]; orders-db still Confirmed and flaggable.
  })
})

describe("every 'On it' is answered (AckIsAnswered)", () => {
  it("a question naming no resource gets 'I couldn't find that out'", () => {
    // agent fails; direct.answer -> Unknown (no resource named) -> Ready{Unknown} -> answer at the gap; pending -> 0
  })
})

describe("jobs start only after commit (finding 4)", () => {
  it("a Heard step queues the job; only JobStarted makes it Running; a duplicate JobDone is a no-op", () => {})
})
