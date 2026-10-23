/**
 * Event: what one Bridge input did, for the dashboard, the page and the Judge.
 *
 * Changes from today's Event (Bridge.ts):
 *  - `said` + `saidKind` are replaced by ONE field, `speech`, which carries the text and everything
 *    the Judge needs without reading the words: kind, certainty (firm|tentative), basis
 *    (confirmed|fastCheck) and whom/what it was about.
 *  - `agent`, `request`, `claim`, `note` (each overwritten when a step did two things) are replaced by
 *    `moves`: a typed list, one entry per thing that happened. Judge reads: Dispatched (a confirm,
 *    recheck or answer job), Closed{why:"parked", resource} (the Closes outcome), Reported outcomes.
 *  - `Note` moves are for people only and are never judged.
 */
import { Schema } from "effect"
import * as G from "./Gate.ts"
import { Route } from "./Router.ts"
import { SaidKind } from "./Expect.ts"
import { Basis, Certainty, ClaimId, JobId, RequestId, SpeechId } from "./Ids.ts"

export const Verdict = Schema.Literals(["supports", "contradicts", "inconclusive"])
export const JobKind = Schema.Literals(["confirm", "recheck", "answer"])
export type JobKind = typeof JobKind.Type
export const Via = Schema.Literals(["investigator", "direct"])

export const Speech = Schema.Struct({
  id: SpeechId,
  kind: SaidKind, // flag | ack | take | answer | barge | retract   ("retract" is new, see rationale)
  text: Schema.String,
  certainty: Certainty,
  /** Claims only: who vouches for what was said. */
  basis: Schema.OptionFromNullOr(Basis),
  toward: Schema.String,
  /** The resource it is about (claim's resource, or the one a question names). */
  about: Schema.OptionFromNullOr(Schema.String)
})
export type Speech = typeof Speech.Type

export const ClosedWhy = Schema.Literals(["spoken", "corrected", "overruled", "parked", "undetermined", "unverifiable"])
export const JobEnd = Schema.Literals(["found", "unknown", "failed", "timedOut", "cancelled"])

export const Move = Schema.Union([
  Schema.TaggedStruct("Opened", { claim: ClaimId, resource: Schema.String, check: Schema.String, turn: Schema.Int }),
  Schema.TaggedStruct("Dispatched", { job: JobId, kind: JobKind, via: Via, claim: Schema.OptionFromNullOr(ClaimId), request: Schema.OptionFromNullOr(RequestId), detail: Schema.String }),
  Schema.TaggedStruct("Reported", { job: JobId, kind: JobKind, end: JobEnd, detail: Schema.String, by: Schema.String, ms: Schema.Number }),
  /** A claim left the ledger without being said, or by being said. `resource` is what parking is scoped to. */
  Schema.TaggedStruct("Closed", { claim: ClaimId, resource: Schema.String, why: ClosedWhy, detail: Schema.String }),
  Schema.TaggedStruct("Requested", { request: RequestId, kind: Schema.Literals(["addressed", "open"]), speaker: Schema.String, phase: Schema.Literals(["listening", "working", "ready", "answered", "dropped"]), detail: Schema.String }),
  /** Egg Head would have spoken but the floor rule says no (one line per gap, speaking, composing, analysing). */
  Schema.TaggedStruct("Held", { why: Schema.Literals(["speaking", "composing", "analysing", "oneLinePerGap"]) }),
  Schema.TaggedStruct("Note", { text: Schema.String })
])
export type Move = typeof Move.Type

export const Event = Schema.Struct({
  seq: Schema.Int, // dense and ordered: a consumer can see it missed one
  turn: Schema.Int,
  speaker: Schema.String,
  text: Schema.String,
  // understanding of the line (unchanged from today)
  deciderMs: Schema.Number,
  route: Schema.OptionFromNullOr(Route),
  verdict: Schema.OptionFromNullOr(Verdict),
  checkEvidence: Schema.OptionFromNullOr(Schema.String),
  gate: Schema.OptionFromNullOr(G.GateDecision),
  gateScores: Schema.Record(Schema.String, Schema.Number),
  escalations: Schema.Int,
  // what the Bridge did about it
  speech: Schema.OptionFromNullOr(Speech),
  moves: Schema.Array(Move)
})
export type Event = typeof Event.Type
