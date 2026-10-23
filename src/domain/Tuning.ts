/**
 * Tuning: every threshold and timing the Bridge compares against, in one record it reads once
 * when it is built.
 *
 * The defaults are the constants in Gate.ts and Conversation.ts, which stay the source of
 * truth. Production never provides Tuning. test/Mutants.test.ts builds the Bridge with one
 * wrong value at a time and requires a scenario to fail, so a comparison that bypasses this
 * record (or a behaviour no scenario covers) shows up as a surviving mutant.
 */
import { Context } from "effect"
import * as C from "./Conversation.ts"
import * as G from "./Gate.ts"

export interface TuningShape extends C.ReplyTuning {
  readonly gate: G.GateTuning
  readonly addressed: number // P(talking to Egg Head)
  readonly asks: number // P(a question to the call)
  readonly directive: number // P(telling someone to act now): barge-in
  readonly openSilenceS: number // a question nobody answers for this long is Egg Head's
  readonly parked: number // P(a line parks a claim's resource); regex rule is 0 or 1
  readonly floor: {
    readonly quietAfterSpeechS: number
    readonly maxSpeechS: number
    readonly composeDeadlineS: number
  }
  readonly jobs: { readonly confirmS: number; readonly answerS: number; readonly recheckS: number }
}

export const DEFAULTS: TuningShape = {
  ...C.REPLY_DEFAULTS,
  gate: G.GATE_DEFAULTS,
  addressed: C.T_ADDRESSED,
  asks: C.T_ASKS,
  directive: C.T_DIRECTIVE,
  openSilenceS: C.OPEN_SILENCE_S,
  parked: 0.5,
  floor: { quietAfterSpeechS: 3, maxSpeechS: 20, composeDeadlineS: 10 },
  jobs: { confirmS: 45, answerS: 45, recheckS: 8 }
}

export const Tuning = Context.Reference<TuningShape>("egghead/Tuning", { defaultValue: () => DEFAULTS })

/** One or more knobs changed; `gate` merges field by field. */
export type TuningPatch = Partial<Omit<TuningShape, "gate" | "floor" | "jobs">> & {
  readonly gate?: Partial<G.GateTuning>
  readonly floor?: Partial<TuningShape["floor"]>
  readonly jobs?: Partial<TuningShape["jobs"]>
}

export const patch = (p: TuningPatch, base: TuningShape = DEFAULTS): TuningShape => ({
  ...base,
  ...p,
  gate: { ...base.gate, ...p.gate },
  floor: { ...base.floor, ...p.floor },
  jobs: { ...base.jobs, ...p.jobs }
})
