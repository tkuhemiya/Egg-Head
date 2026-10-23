/**
 * Agenda: what Egg Head would say next, in priority order. The only module that looks across
 * claims AND requests; it reads, it does not write (Step applies the Intent through the owners).
 *
 *   1 Answer   a Ready request (asked-for; never held by cooldown)
 *   2 Ack      an addressed Listening request whose speaker has finished (readyToReply)
 *   3 Take     an open Listening request nobody answered in openSilenceS
 *   4 Retract  a claim told tentatively that turned out right/unverifiable
 *   5 Flag     the oldest Standing claim for which Gate.decide says speak (each Standing claim is
 *              gated; a parked or blocked one no longer hides the ones behind it)
 *
 * All five need Floor.mayStart (one line per gap). Only Flag also needs the gate's cooldown.
 */
import { Option } from "effect"
import type * as G from "./Gate.ts"
import type { Claim } from "./Claims.ts"
import type { Request } from "./Requests.ts"
import type { Ctx, State } from "./State.ts"

export type Intent =
  | { readonly _tag: "Answer"; readonly request: Request }
  | { readonly _tag: "Ack"; readonly request: Request; readonly why: string }
  | { readonly _tag: "Take"; readonly request: Request }
  | { readonly _tag: "Retract"; readonly claim: Claim }
  | { readonly _tag: "Flag"; readonly claim: Claim; readonly gate: G.GateDecision }

export interface Pick {
  readonly intent: Option.Option<Intent>
  /** The gate decision to show on the event even when nothing is said (head claim), for the dashboard. */
  readonly gate: Option.Option<G.GateDecision>
  readonly held: Option.Option<"speaking" | "composing" | "analysing" | "oneLinePerGap">
}
export const next = (_s: State, _silenceS: number, _ctx: Ctx): Pick => { throw new Error("not implemented") }
