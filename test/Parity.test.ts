/**
 * Parity with the Python runtime this port replaced. Fixtures were exported from the Python
 * code (spike/export_gate_parity.py for the gate; the questions and Bridge traces were
 * snapshotted from egghead/ before it was removed, see each fixture's `source`).
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, Stream } from "effect"
import { DecisionModel } from "effect/ai"
import gateFixture from "./fixtures/gate-parity.json" with { type: "json" }
import questionsFixture from "./fixtures/questions-parity.json" with { type: "json" }
import bridgeFixture from "./fixtures/bridge-parity.json" with { type: "json" }
import { Bridge, type CallInput, type Event } from "../src/Bridge.ts"
import { MockSource } from "../src/Checks.ts"
import { ScriptedDecider, type SystemOneAnswer } from "../src/Decider.ts"
import * as G from "../src/Gate.ts"
import type { LedgerItem } from "../src/Ledger.ts"
import { buildQuestions, renderState, type Turn } from "../src/Questions.ts"
import { Escalator, type Route } from "../src/Router.ts"
import { templateLine, Writer } from "../src/Speaker.ts"

const fromPython = (i: Record<string, any>): G.GateInput => ({
  check: i.check,
  status: i.status,
  laterTurns: i.later_turns,
  silenceS: i.silence_s,
  selfRepairedP: i.self_repaired_p,
  interruptP: i.interrupt_p,
  laterClaimSupportsCheck: i.later_claim_supports_check,
  secondsSinceLastSpoke: i.seconds_since_last_spoke ?? Infinity
})

const toPython = (d: G.GateDecision): Record<string, unknown> => ({
  speak: d.speak,
  blocked_by: Option.getOrNull(d.blockedBy),
  repaired_by: Option.getOrNull(d.repairedBy),
  cost_level: d.costLevel,
  floor_p: d.floorP,
  reasons: d.reasons
})

/** itertools.product order: the last axis varies fastest. */
const product = <T>(axes: ReadonlyArray<ReadonlyArray<T>>): Array<Array<T>> =>
  axes.reduce<Array<Array<T>>>((acc, axis) => acc.flatMap((prefix) => axis.map((v) => [...prefix, v])), [[]])

describe("gate parity with spike/egghead_gate.py", () => {
  it("reproduces REPORT-gate.md on the 16 pass-2 snippets", () => {
    let tp = 0, fp = 0, fn = 0
    for (const row of gateFixture.pass2) {
      const d = G.decide(fromPython(row.input))
      assert.deepStrictEqual(toPython(d), row.decision, row.id)
      if (d.speak && row.gold) tp++
      if (d.speak && !row.gold) fp++
      if (!d.speak && row.gold) fn++
    }
    // REPORT-gate.md: reworked gate precision 100%, recall 100% (TP 8, FP 0, FN 0, n 16)
    assert.deepStrictEqual({ tp, fp, fn, n: gateFixture.pass2.length }, { tp: 8, fp: 0, fn: 0, n: 16 })
  })

  it("matches every point of the input grid", () => {
    const names = Object.keys(gateFixture.axes)
    const points = product(Object.values(gateFixture.axes) as Array<Array<unknown>>)
    assert.strictEqual(points.length, gateFixture.grid.length)
    points.forEach((values, i) => {
      const kw = Object.fromEntries(names.map((n, j) => [n, values[j]]))
      const d = G.decide(fromPython(kw))
      const mask = gateFixture.reasons.reduce((m, k, bit) => (d.reasons[k as G.Reason] ? m : m | (1 << bit)), 0)
      const got = [d.speak, Option.getOrNull(d.blockedBy), Option.getOrNull(d.repairedBy), d.costLevel, d.floorP, mask]
      assert.deepStrictEqual(got, gateFixture.grid[i], JSON.stringify(kw))
    })
  })
})

describe("question parity with egghead/questions.py", () => {
  const item: LedgerItem = {
    speaker: "Sam",
    claim: "The DB is fine, it's the API.",
    check: "db_health",
    resource: "orders-db",
    status: "degraded",
    evidence: "CPU 98% for the last 6 min; alarm OrdersDB-CPU in ALARM",
    turn: 1,
    raised: false
  }
  const turns: ReadonlyArray<Turn> = [
    ["Priya", "What are we seeing?"],
    ["Sam", "The DB is fine, it's the API."],
    ["Priya", "Okay, let's focus on the API then."]
  ]

  // The request body the provider sends, captured from the scripted backend.
  const requestFor = (withPolicy: boolean) =>
    Effect.gen(function*() {
      const def = buildQuestions(questionsFixture.resources, withPolicy)
      yield* DecisionModel.decide(def, { input: "state" }).pipe(Effect.ignore)
      const [call] = yield* (yield* ScriptedDecider).calls
      return call!.questions
    }).pipe(Effect.provide(ScriptedDecider.layer([])))

  it.effect("sends the same questions, in the same option order", () =>
    Effect.gen(function*() {
      // JSON.stringify compares key order too: option order is part of the prompt.
      assert.strictEqual(JSON.stringify(yield* requestFor(false)), JSON.stringify(questionsFixture.questions_routing))
      assert.strictEqual(JSON.stringify(yield* requestFor(true)), JSON.stringify(questionsFixture.questions_policy))
    }))

  it("renders the same state and spoken template", () => {
    assert.strictEqual(renderState(turns, [item]), questionsFixture.state_open)
    assert.strictEqual(renderState(turns.slice(0, 1), []), questionsFixture.state_none)
    assert.strictEqual(templateLine(item), questionsFixture.template_line)
  })
})

describe("Bridge parity with egghead/bridge.py", () => {
  const er = bridgeFixture.escalatorRoute
  const escalator = Layer.succeed(Escalator, Escalator.of({
    // Python's escalator returned route() of a confident routed() batch.
    route: () =>
      Effect.succeed<Route>({
        action: "check",
        check: Option.some(er.check),
        resource: Option.some(er.resource),
        asserted: Option.some(er.asserted),
        scores: { is_claim: 0.85, which_check: (7 * 0.9 - 1) / 6, which_resource: (7 * 0.9 - 1) / 6 }
      })
  }))

  const toPythonEvent = (ev: Event) => {
    const rt = Option.getOrNull(ev.route)
    const gate = Option.getOrNull(ev.gate)
    return {
      turn: ev.turn,
      speaker: ev.speaker,
      text: ev.text,
      route: rt && {
        action: rt.action,
        check: Option.getOrNull(rt.check),
        resource: Option.getOrNull(rt.resource),
        asserted: Option.getOrNull(rt.asserted),
        scores: rt.scores
      },
      verdict: Option.getOrNull(ev.verdict),
      checkEvidence: Option.getOrNull(ev.checkEvidence),
      gate: gate && {
        speak: gate.speak,
        blockedBy: Option.getOrNull(gate.blockedBy),
        repairedBy: Option.getOrNull(gate.repairedBy),
        costLevel: gate.costLevel,
        floorP: gate.floorP,
        reasons: gate.reasons
      },
      said: Option.getOrNull(ev.said),
      escalations: ev.escalations
    }
  }

  for (const [name, sc] of Object.entries(bridgeFixture.scenarios)) {
    it.effect(name, () =>
      Effect.gen(function*() {
        const bridge = yield* Bridge
        const events: Array<unknown> = []
        for (const step of sc.steps) {
          if (step._tag === "Utterance") {
            events.push(toPythonEvent(yield* bridge.hear(step.speaker!, step.text!, step.silenceS)))
          } else {
            events.push(Option.getOrNull(Option.map(yield* bridge.tick(step.silenceS), toPythonEvent)))
          }
        }
        const s = yield* bridge.state
        // Python's scores carry rounded confidences from the fixture; compare them loosely.
        assert.deepStrictEqual(roundScores(events), roundScores(sc.events), name)
        assert.deepStrictEqual(s.ledger.map(({ check, resource, raised }) => ({ check, resource, raised })), sc.ledger)
        assert.strictEqual(s.escalations, sc.escalationCount)
      }).pipe(Effect.provide(layerFor(sc.steps, sc.escalate))))
  }

  it.effect("run() over a stream gives the same decisions as hear/tick", () => {
    const sc = bridgeFixture.scenarios.long_call
    const inputs = sc.steps.map((s): CallInput =>
      s._tag === "Utterance"
        ? { _tag: "Utterance", speaker: s.speaker!, text: s.text!, silenceS: s.silenceS }
        : { _tag: "Silence", silenceS: s.silenceS }
    )
    return Effect.gen(function*() {
      const bridge = yield* Bridge
      const events = yield* Stream.runCollect(bridge.run(Stream.fromIterable(inputs)))
      assert.deepStrictEqual(roundScores(Array.from(events, toPythonEvent)), roundScores(sc.events.filter((e) => e !== null)))
    }).pipe(Effect.provide(layerFor(sc.steps, false)))
  })

  function layerFor(steps: ReadonlyArray<{ _tag: string; answers?: unknown }>, withEscalator: boolean) {
    const batches = steps.flatMap((s) => (s._tag === "Utterance" ? [s.answers as Record<string, SystemOneAnswer>] : []))
    const deps = Layer.mergeAll(ScriptedDecider.layer(batches), MockSource.layer(), Writer.template)
    return Bridge.layer.pipe(Layer.provide(withEscalator ? Layer.merge(deps, escalator) : deps))
  }
})

const roundScores = (events: ReadonlyArray<unknown>) =>
  JSON.parse(JSON.stringify(events, (_k, v) => (typeof v === "number" && !Number.isInteger(v) ? Math.round(v * 1e5) / 1e5 : v)))
