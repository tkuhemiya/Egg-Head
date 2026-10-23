/**
 * Policy: at a moment with no new words (a heard line just applied, or more silence), which
 * one line does Egg Head say, if any? Pure. Replaces Bridge.converse / decide / step / floorOpen.
 *
 * One ordered list of candidates, the first that is due wins, then one shared hold:
 *
 *   1. owed     an update after a tentative barge (Claims.Correcting), then a Ready answer.
 *               Needs the floor open (Gate.floorOpen). Never held by the cooldown.
 *   2. reply    ack an addressed request once the speaker has finished (Conversation.readyToReply),
 *               or take an open question nobody answered in openSilenceS. Starts an answer job.
 *   3. flag     the oldest Confirmed claim, through Gate.decide (all six reasons, cooldown included).
 *
 *   hold        whatever was chosen waits if Speech.gap says "speaking" or "gap", or if a heard
 *               line is still being analysed ("analysing": the answer to a hanging question may
 *               be in it; gotcha 20). The gate decision is recorded on the event either way, so
 *               the parity traces still see the gate on every step.
 *
 * Barge-in is not here: it is the one line decided on a partial, while someone is talking
 * (Core.partial). The mode decides which candidates exist (Mode.requests), not branches inside them.
 */
import { Option } from "effect"
import type { Claim } from "./Claims.ts"
import type { Basis, Certainty, ClaimId, RequestId } from "./Event.ts"
import type { GateDecision } from "./Gate.ts"
import type { Mode, State } from "./Core.ts"
import type { Hold } from "./Speech.ts"
import type { TuningShape } from "./Tuning.ts"

export interface Moment {
  readonly now: number // Clock seconds
  readonly silenceS: number // the caller's VAD silence (humans)
}

/** What the policy picked. Wording is chosen by Conversation from the plan, not here. */
export type Plan =
  | { readonly _tag: "Update"; readonly claim: ClaimId }
  | { readonly _tag: "Answer"; readonly request: RequestId }
  | { readonly _tag: "Ack"; readonly request: RequestId; readonly why: string }
  | { readonly _tag: "Take"; readonly request: RequestId; readonly why: string }
  | {
    readonly _tag: "Flag"
    readonly claim: ClaimId
    readonly certainty: Certainty // basis confirmed -> firm; fastCheck -> tentative ("couldn't confirm further")
    readonly basis: Basis
    /** A line written in code (the Investigator's fact), or one the Writer must write (Bedrock / template). */
    readonly wording: "code" | "writer"
  }

export interface Choice {
  readonly plan: Option.Option<Plan>
  /** The gate's verdict on the head claim, when there was one (recorded on the event). */
  readonly gate: Option.Option<readonly [Claim, GateDecision]>
  /** The plan exists but must wait. */
  readonly held: Option.Option<Hold | "analysing">
  /** Dashboard notes ("Priya is talking to Egg Head but has not finished: trails off"), each shown once. */
  readonly notes: ReadonlyArray<string>
}

export const choose = (s: State, m: Moment, mode: Mode, t: TuningShape): Choice => {
  throw new Error("not implemented")
}

/** 1. */
export const owed = (s: State, m: Moment, t: TuningShape): Option.Option<Plan> => {
  throw new Error("not implemented")
}
/** 2. */
export const reply = (s: State, m: Moment, t: TuningShape): readonly [Option.Option<Plan>, ReadonlyArray<string>] => {
  throw new Error("not implemented")
}
/** 3. */
export const flag = (s: State, m: Moment, t: TuningShape): readonly [Option.Option<Plan>, Option.Option<readonly [Claim, GateDecision]>] => {
  throw new Error("not implemented")
}
