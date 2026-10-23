/**
 * Reading: the three language judgments about one item and the lines since it
 * (docs/design/decider-on-state.md), behind one seam:
 *
 *   corrects(claim X, lines since X)     -> P(the call corrected X)
 *   parks(resource R, lines since ...)   -> P(the call set R aside)
 *   answers(question Q, lines since Q)   -> P(someone on the call answered Q)
 *
 * The Bridge asks once per heard line, for every live claim, every resource with a live claim
 * and every open Listening question, in one call, so a Decider implementation (W5, exp 12)
 * can batch them (8 questions per request). Thresholds live in Tuning.reading; the Bridge
 * compares, the seam only reads. Timing, cooldowns and state transitions never come through here.
 *
 * `Reading.rules` is today's behaviour, moved out of Gate.ts and Bridge.ts unchanged except
 * for the owner's parking decision:
 * - corrects: the REPAIR regex on any line since the claim (by "keyword", p = 1); otherwise the
 *   line's generic Decider `self_repaired` (by "decider", p = rep). Same as Gate.repairedBy.
 * - parks: the PARKED regex on a line since the claim that names R by alias (Router.aliasHits).
 *   Today the regex alone parked every open claim; scoping it to R is the deliberate change.
 * - answers: a different speaker spoke after the question (by "speaker", p = 1).
 * The `ledger` repair (a later true claim on the same check and resource) is not language: it
 * is code in Core (a `supports` verdict closes that claim).
 */
import { Context, Effect, Layer, Option } from "effect"
import type { AiError } from "effect/ai"
import type { ClaimId, RequestId } from "./Event.ts"
import type { Turn } from "./Questions.ts"

export interface Judged<By extends string> {
  readonly p: number
  readonly by: By
}

export interface ReadingInput {
  readonly claims: ReadonlyArray<{ readonly id: ClaimId; readonly speaker: string; readonly text: string; readonly resource: string; readonly since: ReadonlyArray<Turn> }>
  readonly questions: ReadonlyArray<{ readonly id: RequestId; readonly speaker: string; readonly text: string; readonly since: ReadonlyArray<Turn> }>
  /** The line's generic turn answers, when Observe asked them (`rep` is today's third repair vote). */
  readonly selfRepairedP: Option.Option<number>
}

export interface Readings {
  readonly corrects: ReadonlyMap<ClaimId, Judged<"keyword" | "decider">>
  readonly parks: ReadonlyMap<string, Judged<"keyword" | "decider">> // by resource
  readonly answers: ReadonlyMap<RequestId, Judged<"speaker" | "decider">>
}

export class Reading extends Context.Service<Reading, {
  readonly name: string
  read(input: ReadingInput): Effect.Effect<Readings, AiError.AiError>
}>()("egghead/Reading") {
  /** Today's rules. The default: production provides nothing and gets this. */
  static readonly rules: Layer.Layer<Reading> = Layer.succeed(Reading, Reading.of({
    name: "rules",
    read: (input) => Effect.succeed(rules(input))
  }))
  // W5: static readonly decider: Layer<Reading, never, DecisionModel> — state-scoped yes/no
  // questions (claim or question + latest line, kv format), Platt-calibrated on dev.
}

/** Pure, so the gate parity test composes it with Gate.decide over the Python fixture rows. */
export const rules = (input: ReadingInput): Readings => {
  throw new Error("not implemented")
}

/** The same rules on bare text, for test/Parity.test.ts (fixture rows carry `later_turns` and a resource). */
export const correctedIn = (laterTurns: ReadonlyArray<string>, selfRepairedP: number): Judged<"keyword" | "decider"> => {
  throw new Error("not implemented")
}
export const parkedIn = (resource: string, laterTurns: ReadonlyArray<string>): boolean => {
  throw new Error("not implemented")
}

// REPAIR and PARKED move here from Gate.ts, verbatim.
