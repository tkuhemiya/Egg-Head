/**
 * Slow work against a snapshot, no lock. Produces Evidence for the reducer.
 */
import { Duration, Effect, Option } from "effect"
import { DecisionModel } from "effect/ai"
import { compare, inferAsserted } from "./Compare.ts"
import * as C from "./Conversation.ts"
import { isOpen } from "./Claims.ts"
import type { CheckSource } from "./Checks.ts"
import * as J from "./Judgments.ts"
import { finishedProbability, gateQuestions, renderGate, renderKv } from "./Questions.ts"
import { Escalator, route } from "./Router.ts"
import { WINDOW_TURNS } from "./State.ts"
import type { LineEvidence, PartialEvidence, Policy, State } from "./State.ts"
import type { TuningShape } from "./Tuning.ts"

export interface Deps {
  readonly decider: DecisionModel.DecisionModel
  readonly source: CheckSource["Service"]
  readonly escalator: Escalator["Service"] | undefined
  readonly judgments: J.JudgmentsShape
  readonly tuning: TuningShape
  readonly policy: Policy
}

type GateAns = { rep: { probability: number }; fin: { probability: number }; addr?: { probability: number }; ask?: { probability: number } }

export const line = (
  snapshot: State,
  _turn: number,
  silenceS: number,
  deps: Deps
) =>
  Effect.gen(function*() {
    const window = snapshot.turns.slice(-WINDOW_TURNS)
    const openClaims = snapshot.claims.filter(isOpen)
    const inventory = yield* deps.source.inventory
    const flagged = openClaims.map((c) => ({ speaker: c.speaker, claim: c.claim, evidence: c.evidence }))
    const gateState = renderGate(window, silenceS, flagged)
    const d = deps.decider
    const askGate = Effect.map(d.decide(gateQuestions, { input: gateState }), (r) => r.answers as GateAns)
    const askTurn = Effect.map(d.decide(C.turnQuestions, { input: gateState }), (r) => r.answers as GateAns)
    const [elapsed, [routed0, gateAnswers]] = yield* Effect.timed(Effect.all([
      route(window, inventory).pipe(Effect.provideService(DecisionModel.DecisionModel, d)),
      deps.policy.conversation ? Effect.asSome(askTurn) : openClaims.length > 0 ? Effect.asSome(askGate) : Effect.succeedNone
    ], { concurrency: "unbounded" }))
    let rt = routed0
    const handedOff = rt.action === "escalate"
    if (handedOff && deps.escalator) {
      const decided = rt
      rt = yield* deps.escalator.route(window)
      rt = { ...rt, scores: { ...decided.scores, ...rt.scores } }
    }
    const finished = Option.map(gateAnswers, (a) => finishedProbability(a.fin.probability))
    const signals = Option.map(gateAnswers, (a) => ({
      finishedP: Option.getOrElse(finished, () => 0.5),
      finishedRaw: a.fin.probability,
      selfRepairedP: a.rep.probability,
      addressedP: a.addr ? Option.some(a.addr.probability) : Option.none<number>(),
      asksP: a.ask ? Option.some(a.ask.probability) : Option.none<number>()
    }))
    let check: LineEvidence["check"] = Option.none()
    const supports: Array<{ check: string; resource: string }> = []
    if (rt.action === "check" && Option.isSome(rt.check) && Option.isSome(rt.resource)) {
      const res = yield* deps.source.run(rt.check.value, rt.resource.value)
      if (Option.isSome(res)) {
        const asserted = Option.getOrNull(rt.asserted)
        const claimed = asserted === "unclear" ? inferAsserted(window[window.length - 1]?.[1] ?? "") : asserted
        const verdict = compare(claimed, res.value.status)
        check = Option.some({
          check: rt.check.value,
          resource: rt.resource.value,
          status: res.value.status,
          evidence: res.value.evidence,
          verdict,
          asserted: Option.fromNullishOr(claimed)
        })
        if (verdict === "supports") supports.push({ check: rt.check.value, resource: rt.resource.value })
      }
    }
    const queries: Array<J.Query> = [
      ...openClaims.flatMap((c) => [{ _tag: "Corrects" as const, claim: c }, { _tag: "Parks" as const, claim: c }]),
      ...snapshot.requests.filter((r) => r.phase._tag === "Listening").map((r) => ({ _tag: "Answers" as const, request: r }))
    ]
    const verdicts = queries.length === 0
      ? []
      : yield* deps.judgments.judge(queries, snapshot.turns, { selfRepairedP: Option.getOrElse(Option.map(signals, (x) => x.selfRepairedP), () => 0) }, { supports })
    return {
      deciderMs: Duration.toMillis(elapsed),
      route: rt,
      handedOff,
      signals,
      check,
      verdicts
    }
  })

export const partial = (
  snapshot: State,
  _claimId: string,
  speaker: string,
  text: string,
  deps: Deps
) =>
  Effect.gen(function*() {
    const window = [...snapshot.turns.slice(-WINDOW_TURNS), [speaker, text] as const]
    const [elapsed, out] = yield* Effect.timed(deps.decider.decide(C.directiveQuestions, { input: renderKv(window, 1) }))
    return { deciderMs: Duration.toMillis(elapsed), actP: (out.answers as { act: { probability: number } }).act.probability, verdicts: [] }
  })
