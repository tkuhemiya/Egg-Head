/**
 * Tuning (delta): the new numbers the redesign compares against. Every one goes through this
 * record, so test/Mutants.test.ts can break it and a scenario must notice.
 */
import type * as C from "./Conversation.ts"
import type * as G from "./Gate.ts"

export interface TuningShape extends C.ReplyTuning {
  readonly gate: G.GateTuning
  readonly addressed: number
  readonly asks: number
  readonly directive: number
  readonly openSilenceS: number

  /** Owner's one-line-per-gap: after Egg Head finishes, this much silence (or a human turn) before its next line. Unmeasured. */
  readonly quietS: number // 2.0
  /** Speaking ends by itself after this long if the caller never reports `finished`. */
  readonly maxLineS: number // 20
  /** Seam thresholds (Reading.ts). corrects = gate.selfRepaired (0.45) by default, so parity holds. */
  readonly reading: { readonly corrects: number; readonly parks: number; readonly answers: number } // 0.45, 0.5, 0.5
  /** Bridge-owned deadlines, from the moment a job is queued. */
  readonly jobs: { readonly confirm: number; readonly recheck: number; readonly answer: number } // 45, 5, 30
  /** Bound on one line's analysis (Decider + check + seam) and on the Writer / Escalator. */
  readonly observeS: number // 20
  readonly writeS: number // 8
}
