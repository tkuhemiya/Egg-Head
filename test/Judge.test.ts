/**
 * The judge on hand-written call logs: no Bridge, no clock. What each expectation accepts and,
 * as much, what it rejects.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Option, Result } from "effect"
import type { Event } from "../src/Bridge.ts"
import { type Call, type CallLine, decodeLog, encodeLogged, type Logged } from "../src/Call.ts"
import { afterEnd, type Invariant, investigates, says } from "../src/Expect.ts"
import { judge, LIVE, OFFLINE, type Report } from "../src/Judge.ts"

const marks = { words: [], visemes: [] }
const ms = (s: number) => Math.round(s * 1000)

const line = (index: number, at: number, durationS: number, text: string, speaker = "Lee"): Logged => ({
  type: "line", at: ms(at), index, speaker, text, audio: "", durationS, expect: "", marks
})
const cut = (index: number, at: number): Logged => ({ type: "cut", at: ms(at), index, speaker: "Priya", text: "Jordan, restart" })
const done = (at: number): Logged => ({ type: "done", at: ms(at) })

const event = (index: number, at: number, e: Partial<Event>): Logged => ({
  type: "event",
  at: ms(at),
  index,
  event: {
    turn: index, speaker: "(silence)", text: "", deciderMs: 0, route: Option.none(), verdict: Option.none(), checkEvidence: Option.none(),
    gate: Option.none(), gateScores: {}, said: Option.none(), escalations: 0, ...e
  }
})
/** A claim heard on line `index` about `resource`. */
const heard = (index: number, at: number, speaker: string, resource: string): Logged =>
  event(index, at, {
    speaker,
    route: Option.some({ action: "check", check: Option.some("db_health"), resource: Option.some(resource), asserted: Option.some("healthy"), scores: {} })
  })
const request = (speaker: string, text: string, kind: "addressed" | "open") =>
  ({ id: 1, kind, speaker, text, turn: 0, state: "checking", answer: Option.none(), note: "" }) as const
const said = (index: number, at: number, text: string, e: Partial<Event>): Array<Logged> => [
  event(index, at, { said: Option.some(text), ...e }),
  { type: "egghead", at: ms(at), index, text, audio: "", durationS: 1.5, marks, kind: e.saidKind ?? "line" }
]

const QUESTION = "Did anyone push anything to the payments API today?"
const callOf = (lines: ReadonlyArray<Partial<CallLine> & { text: string }>, never?: ReadonlyArray<Invariant>): Call => ({
  title: "t",
  voices: {},
  ...(never ? { never } : {}),
  lines: lines.map((l) => ({ speaker: "Lee", pause: 0.5, ...l }))
})
const take = callOf([{ text: QUESTION, expect: [investigates("answer"), says("take", { toward: "Lee", about: "payments-api", when: afterEnd(2.5, 3.0) })] }])
const takeLog = (takeAt: number, kind: "open" | "addressed" = "open") => [
  line(0, 0, 3, QUESTION),
  ...said(0, takeAt, "I can check that.", { saidKind: "ack", request: request("Lee", QUESTION, kind), agent: { task: 1, job: "answer", action: "dispatched", detail: "" } }),
  done(10)
]

const report = (call: Call, log: ReadonlyArray<Logged>, tol = OFFLINE): Report => Result.getOrThrow(judge(call, log, tol))
const problems = (r: Report, i = 0) => r.lines[i]!.problems.map((p) => p._tag === "Mismatch" ? `Mismatch:${p.fields.join(",")}` : p._tag)

describe("judge", () => {
  it("passes a take 2.6 s after the line, toward the asker, about what was asked", () => {
    const r = report(take, takeLog(5.6))
    assert.isTrue(r.passed, r.summary)
    assert.strictEqual(r.summary, "1 of 1 lines behaved as expected")
  })

  it("fails a take 1 s after the line, offline and live: early is never forgiven", () => {
    assert.deepStrictEqual(problems(report(take, takeLog(4))), ["Mismatch:when"])
    assert.deepStrictEqual(problems(report(take, takeLog(4), LIVE)), ["Mismatch:when"])
  })

  it("forgives half a second late live, not offline", () => {
    assert.deepStrictEqual(problems(report(take, takeLog(6.5))), ["Mismatch:when"])
    assert.isTrue(report(take, takeLog(6.5), LIVE).passed)
  })

  it("does not count an ack to someone who asked Egg Head by name as taking a question", () => {
    assert.deepStrictEqual(problems(report(take, takeLog(5.6, "addressed"))), ["Missing", "Unexpected"])
  })

  it("fails a quiet line that speaks, and says where a missing line went", () => {
    const call = callOf([{ text: "One." }, { text: "Two.", expect: [says("flag")] }])
    const log = [line(0, 0, 1, "One."), ...said(0, 1.6, "Quick flag", {}), line(1, 3, 1, "Two."), done(6)]
    const r = report(call, log)
    assert.deepStrictEqual([problems(r, 0), problems(r, 1)], [["Unexpected"], ["Missing"]])
    const missing = r.lines[1]!.problems[0]!
    assert.deepStrictEqual(missing._tag === "Missing" && Option.getOrNull(missing.foundIn), 0)
  })

  it("reads whom a flag is for and what it is about from the claim it raises", () => {
    const call = callOf([
      { speaker: "Sam", text: "The orders DB is fine." },
      { text: "Okay.", expect: [says("flag", { toward: "Sam", about: "orders-db" })] }
    ])
    const log = (resource: string) => [
      line(0, 0, 1, "The orders DB is fine.", "Sam"),
      heard(0, 1.3, "Sam", resource),
      line(1, 1.5, 1, "Okay."),
      ...said(1, 3, "Quick flag", { claim: 0 }),
      done(6)
    ]
    assert.isTrue(report(call, log("orders-db")).passed)
    assert.deepStrictEqual(problems(report(call, log("payments-db")), 1), ["Mismatch:about"])
  })

  it("expects a barge exactly when the line is cut off", () => {
    const call = callOf([{ speaker: "Priya", text: "Jordan, restart the payments API now.", expect: [says("barge", { toward: "Priya" })] }])
    const cutLog = [line(0, 0, 3, "Jordan, restart the payments API now.", "Priya"), ...said(0, 1.2, "Sorry to cut in", { speaker: "Priya", saidKind: "barge" }), cut(0, 1.2), done(5)]
    assert.isTrue(report(call, cutLog).passed)
    assert.deepStrictEqual(problems(report(call, [line(0, 0, 3, "Jordan, restart the payments API now.", "Priya"), done(5)])), ["Missing"])
  })

  it("fails lines the run never reached, and a run that did not finish", () => {
    const r = report(callOf([{ text: "One." }, { text: "Two." }]), [line(0, 0, 1, "One.")])
    assert.deepStrictEqual(problems(r, 1), ["NotPlayed"])
    assert.isFalse(r.passed)
    assert.match(r.summary, /did not finish/)
  })

  it("refuses to score a run of a different script", () => {
    const r = judge(callOf([{ text: "One." }]), [line(0, 0, 1, "Something else.")])
    assert.isTrue(Result.isFailure(r))
  })
})

describe("invariants", () => {
  const lines = [{ text: "One." }, { text: "Two." }]
  const held = (i: Invariant, log: ReadonlyArray<Logged>) => {
    const r = report(callOf(lines.map((l) => ({ ...l, expect: [] })), [i]), log)
    return r.invariants[0]!.ok
  }
  // Egg Head's lines are scored as unexpected here; only the invariant is under test.
  const base = (eggAt: ReadonlyArray<number>, kind: "flag" | "ack" | "barge" = "flag", secondLineAt = 20) => [
    line(0, 0, 2, "One."),
    ...eggAt.flatMap((t) => said(0, t, "Egg Head", { saidKind: kind })),
    line(1, secondLineAt, 2, "Two."),
    done(30)
  ]

  it("NoTalkOver: Egg Head never talks over a person or itself", () => {
    assert.isTrue(held({ _tag: "NoTalkOver" }, base([3])))
    assert.isFalse(held({ _tag: "NoTalkOver" }, base([1])))
    assert.isFalse(held({ _tag: "NoTalkOver" }, base([3], "flag", 4)))
    assert.isFalse(held({ _tag: "NoTalkOver" }, base([3, 4])))
  })

  it("SilenceBeforeSpeaking: not before the silence has lasted", () => {
    assert.isTrue(held({ _tag: "SilenceBeforeSpeaking", minS: 0.5 }, base([2.5])))
    assert.isFalse(held({ _tag: "SilenceBeforeSpeaking", minS: 0.5 }, base([2.3])))
  })

  it("OneLinePerGap: a person speaks, or there is quiet, between Egg Head's lines", () => {
    assert.isTrue(held({ _tag: "OneLinePerGap", quietS: 2 }, base([3, 7])))
    assert.isFalse(held({ _tag: "OneLinePerGap", quietS: 2 }, base([3, 5])))
  })

  it("Cooldown: unprompted flags are spaced out; asked-for lines are not held by it", () => {
    assert.isFalse(held({ _tag: "Cooldown", s: 30 }, base([3, 8])))
    assert.isTrue(held({ _tag: "Cooldown", s: 30 }, base([3, 8], "ack")))
    assert.isTrue(held({ _tag: "Cooldown", s: 3 }, base([3, 8])))
  })

  it("MaxSpeeches", () => {
    assert.isTrue(held({ _tag: "MaxSpeeches", n: 2 }, base([3, 8])))
    assert.isFalse(held({ _tag: "MaxSpeeches", n: 1 }, base([3, 8])))
  })
})

describe("run logs", () => {
  it.effect("decode as saved, skipping what only the page shows", () =>
    Effect.gen(function*() {
      const saved = JSON.parse(JSON.stringify([
        { type: "status", text: "Decider ready", at: 0 },
        ...takeLog(5.6).map((m) => encodeLogged(m)),
        { type: "stats", stats: {}, at: 9000 }
      ]))
      const log = yield* decodeLog(saved)
      assert.deepStrictEqual(log.map((m) => m.type), ["line", "event", "egghead", "done"])
      assert.isTrue(report(take, log).passed)
    }))
})
