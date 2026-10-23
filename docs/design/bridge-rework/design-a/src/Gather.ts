/**
 * Gather: everything slow and everything that may fail, done with NO lock held, against an immutable
 * snapshot, producing Evidence for the reducer. Nothing here writes state.
 *
 * Evidence is keyed by ids (claim id, request id, turn), so applying it to a state that moved
 * (a job finished, a tick spoke) is safe: the reducer ignores verdicts for items no longer in the
 * right phase. New claims only appear through `hear`, which is serialized, so a snapshot never misses one.
 */
import { Effect } from "effect"
import { DecisionModel } from "effect/ai"
import type { AiError } from "effect/ai"
import type { CheckSource } from "./Checks.ts"
import type { Escalator } from "./Router.ts"
import type { SupportError } from "./Speaker.ts"
import type { LineEvidence, PartialEvidence, Policy, State } from "./State.ts"
import type { JudgmentsShape } from "./Judgments.ts"
import type { TuningShape } from "./Tuning.ts"

export interface Deps {
  readonly decider: DecisionModel.Service
  readonly source: CheckSource["Service"]
  readonly escalator: Escalator["Service"] | undefined
  readonly judgments: JudgmentsShape
  readonly tuning: TuningShape
  readonly policy: Policy
}

/**
 * route || line questions (gate or turn batch, chosen by policy)  ->  escalate if the router could not route
 * -> run the check -> Judgments.judge(open claims, open requests, window, answers, facts).
 * Same Decider batches as today, so ScriptedDecider fixtures and the parity traces replay unchanged.
 */
export const line = (_snapshot: State, _turn: number, _deps: Deps): Effect.Effect<LineEvidence, AiError.AiError | SupportError> => { throw new Error("not implemented") }

/** Only called for claims `reserve`d by Bridge.partial: the `act` question plus Judgments.corrects over (lines + the partial). */
export const partial = (_snapshot: State, _claimId: string, _speaker: string, _text: string, _deps: Deps): Effect.Effect<PartialEvidence, AiError.AiError> => { throw new Error("not implemented") }
