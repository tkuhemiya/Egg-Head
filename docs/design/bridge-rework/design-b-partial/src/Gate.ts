/**
 * SpeakGate (delta only; everything not shown is unchanged).
 *
 * The gate stops reading text. Its two language inputs arrive as per-claim judgments from the
 * seam (Reading.ts), and it keeps its six ordered reasons and its numbers:
 *
 *   persisted     laterTurns > 0                        (a count now, not the strings)
 *   not_repaired  repairedBy is None                    (ledger | keyword | decider, decided by Core + Reading)
 *   min_silence   silenceS >= 0.5
 *   floor_open    floorP >= 0.5 or silenceS >= 1.2
 *   worth_it      costLevel >= 2; a parked claim is level 1 (as today, now per claim)
 *   cooldown      sinceUnprompted >= 30                 (flags only; asked-for lines never come here)
 *
 * Core closes a corrected or parked claim in the same step it reads it, after gating the head
 * claim with those judgments, so the gate event still shows `not_repaired` / `worth_it` the way
 * the parity traces record them, and the claim no longer blocks the ones behind it.
 *
 * Parity: test/Parity.test.ts builds GateInput from each fixture row with
 * `Reading.correctedIn(later_turns, self_repaired_p)` (plus later_claim_supports_check for
 * "ledger") and `Reading.parkedIn(resource, later_turns)`. The composition must equal the
 * Python gate on every row. The Python gate gets the same resource scoping (see rationale.md,
 * "Parity"); the 16 pass-2 rows still give REPORT-gate.md's TP 8 / FP 0 / FN 0.
 */
import { Option, Schema } from "effect"

export interface GateInput {
  readonly check: string
  readonly status: string
  readonly laterTurns: number
  readonly silenceS: number
  readonly interruptP: number
  readonly repairedBy: Option.Option<RepairedBy>
  readonly parked: boolean
  readonly sinceUnprompted: number // seconds since the last flag or barge; Infinity before the first
}

export const RepairedBy = Schema.Literals(["ledger", "keyword", "decider"])
export type RepairedBy = typeof RepairedBy.Type

export const Reason = Schema.Literals(["persisted", "not_repaired", "min_silence", "floor_open", "worth_it", "cooldown"])
export type Reason = typeof Reason.Type

export const GateDecision = Schema.Struct({
  speak: Schema.Boolean,
  blockedBy: Schema.OptionFromNullOr(Reason),
  repairedBy: Schema.OptionFromNullOr(RepairedBy),
  costLevel: Schema.Int,
  floorP: Schema.Number,
  reasons: Schema.Record(Reason, Schema.Boolean)
})
export type GateDecision = typeof GateDecision.Type

export interface GateTuning {
  readonly selfRepaired: number // now read by Core against Reading's `corrects` p (by decider)
  readonly floor: number
  readonly minSilenceS: number
  readonly silenceS: number
  readonly costLevel: number
  readonly cooldownS: number
}

export const costLevel = (g: Pick<GateInput, "check" | "status" | "parked">): number => {
  throw new Error("not implemented") // parked ? 1 : min(BASE_COST[check] ?? 2 + (down ? 1 : 0), 4)
}

export const decide = (g: GateInput, t?: GateTuning): GateDecision => {
  throw new Error("not implemented")
}

/** The floor rule asked-for lines use (was Bridge.floorOpen, a copy of the gate's silence rule): one definition. */
export const floorOpen = (g: Pick<GateInput, "silenceS" | "interruptP">, t?: GateTuning): boolean => {
  throw new Error("not implemented")
}
