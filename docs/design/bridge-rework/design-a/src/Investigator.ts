/**
 * DELTA to src/Investigator.ts (demo/Agent.ts already numbers its own jobs, b629bba, so the
 * `task` argument goes: the Bridge's JobId is the identity, the terminal's number is private).
 */
import { Context, Effect } from "effect"
import type { Report } from "./Jobs.ts"
import type { SupportError } from "./Speaker.ts"

export interface ClaimBrief { readonly speaker: string; readonly claim: string; readonly check: string; readonly resource: string; readonly status: string; readonly evidence: string }
export interface Question { readonly speaker: string; readonly text: string; readonly addressed: boolean }

/**
 * Report.Checked | Report.Unknown for claims; Report.Answered | Report.Unknown for questions.
 * `Unknown` ("no data settled it") is a successful result. SupportError means the attempt broke;
 * the Bridge-owned deadline means it was too slow. Both are handled by Jobs/Step, not here.
 * `fact` / `text` are clamped to 240 chars when the Report is decoded (Noted: no length clamp).
 */
export declare class Investigator extends Context.Service<Investigator, {
  readonly name: string
  confirm(claim: ClaimBrief): Effect.Effect<Extract<Report, { _tag: "Checked" | "Unknown" }>, SupportError>
  answer(question: Question): Effect.Effect<Extract<Report, { _tag: "Answered" | "Unknown" }>, SupportError>
}> {}
/*
 direct(source): confirm = re-run the claim's check -> Checked (a missing check -> Unknown);
                 answer  = the check the words point at -> Answered; no resource named -> Unknown (was a SupportError: finding 2)
 demo/Agent.ts: Report gains status/answer "unknown" (egghead report <id> --unknown "why"); AgentTerminal.investigator maps it to Report.Unknown.
*/
