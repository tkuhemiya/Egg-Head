/**
 * The seam (docs/design/decider-on-state.md): three language judgments, each a function from
 * (one item, the recent lines) to a probability. Timing, cooldown and the state machines stay in code.
 *
 *   corrects(claim, lines)   does a line since the claim correct or withdraw it?
 *   parks(claim, lines)      does a line set aside the topic of the claim's resource?
 *   answers(request, lines)  has someone answered this open question?
 *
 * Asked in ONE batch per input over the items open at the snapshot, outside any lock. Results are
 * keyed by item id, so a result for an item that has since closed is ignored by the reducer.
 * Thresholds are applied in the reducer (Tuning), never here.
 *
 * `today` is the current rule, unchanged, so W3 changes no measured behaviour:
 *   corrects: 1 (via ledger)  if this line routes to a true claim on the claim's check+resource (per claim: finding 5)
 *             1 (via keyword) if REPAIR matches any line after the claim
 *             else the line-level Decider `rep` answer (via decider)
 *   parks:    PARKED regex on a line after the claim AND (the line names the claim's resource, OR it names
 *             no resource and the claim is the newest open one: "park that" means the claim in focus).
 *             This is the intentional parking change (owner decision 4); the regex moves out of Gate.costLevel.
 *   answers:  1 if the next line is by a different speaker (today's rule)
 * W5 (exp 12) swaps a state-scoped Decider yes/no behind the same signature via Layer.succeed(Judgments, ...).
 */
import { Context, Effect } from "effect"
import type { AiError } from "effect/ai"
import type { ClaimId, RepairedBy, RequestId } from "./Ids.ts"
import type { Claim } from "./Claims.ts"
import type { Request } from "./Requests.ts"
import type { Turn } from "./Questions.ts"

/** The item-independent Decider answers already asked for the line (today's `rep`); a scoped impl ignores them. */
export interface LineAnswers { readonly selfRepairedP: number }
/** What routing this line found out: claims it supports, keyed by check+resource (not by ledger position). */
export interface LineFacts { readonly supports: ReadonlyArray<{ readonly check: string; readonly resource: string }> }

export type Query =
  | { readonly _tag: "Corrects"; readonly claim: Claim }
  | { readonly _tag: "Parks"; readonly claim: Claim }
  | { readonly _tag: "Answers"; readonly request: Request }

export interface Verdict {
  readonly query: "Corrects" | "Parks" | "Answers"
  readonly item: ClaimId | RequestId
  readonly p: number
  readonly via: RepairedBy | "regex" | "speaker" | "scoped"
}

export interface JudgmentsShape {
  judge(queries: ReadonlyArray<Query>, lines: ReadonlyArray<Turn>, line: LineAnswers, facts: LineFacts): Effect.Effect<ReadonlyArray<Verdict>, AiError.AiError>
}
export const today: JudgmentsShape = { judge: () => { throw new Error("not implemented") } }
/** Like Tuning: a Reference with the current rule as default; tests and W5 override it. */
export const Judgments = Context.Reference<JudgmentsShape>("egghead/Judgments", { defaultValue: () => today })
