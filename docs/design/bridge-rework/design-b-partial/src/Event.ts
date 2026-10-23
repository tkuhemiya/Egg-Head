/**
 * Event: one Bridge decision, as the dashboard, the run log and the Judge see it.
 *
 * Moved out of Bridge.ts so the Judge, the call loop and the pages import the record without
 * importing the Bridge. Every field the behaviour harness judges is a typed field here, never
 * a word Egg Head said:
 *
 *   said.kind / said.certainty / said.basis   what was said, how sure, on what evidence
 *   jobs                                        Investigator jobs queued or settled (incl. recheck)
 *   closes                                      claims closed without speaking, and why (parking, ...)
 *
 * Parity: the fields the parity fixtures compare (turn, speaker, text, route, verdict,
 * checkEvidence, gate, said text, escalations) keep their meaning. `said` becomes a struct;
 * test/Parity.test.ts reads `said.text` (an adapter change, not a fixture change).
 */
import { Schema } from "effect"
import * as G from "./Gate.ts"
import { Route } from "./Router.ts"

export const Verdict = Schema.Literals(["supports", "contradicts", "inconclusive"])

/** Ids are minted by the Bridge from one counter in State, so a JobId is never reused in a run. */
export const ClaimId = Schema.Int.pipe(Schema.brand("ClaimId"))
export type ClaimId = typeof ClaimId.Type
export const RequestId = Schema.Int.pipe(Schema.brand("RequestId"))
export type RequestId = typeof RequestId.Type
export const JobId = Schema.Int.pipe(Schema.brand("JobId"))
export type JobId = typeof JobId.Type
export const UtteranceId = Schema.Int.pipe(Schema.brand("UtteranceId"))
export type UtteranceId = typeof UtteranceId.Type

/**
 * - flag:   raises a wrong claim at a gap, unprompted
 * - ack:    spoken to by name, replies once the speaker has finished ("On it")
 * - take:   takes a question to the call that nobody answered ("I can check that")
 * - answer: the result of a lookup it acked or took (or "I couldn't find that out")
 * - barge:  cuts a speaker off mid-line
 * - update: follows up a tentative barge the second look did not bear out
 */
export const SaidKind = Schema.Literals(["flag", "ack", "take", "answer", "barge", "update"])
export type SaidKind = typeof SaidKind.Type

/** firm: the Investigator confirmed it. tentative: "my quick check shows ..." */
export const Certainty = Schema.Literals(["firm", "tentative"])
export type Certainty = typeof Certainty.Type

/** What a flag or barge rests on: the second look, or the fast check alone (no Investigator, or it failed). */
export const Basis = Schema.Literals(["confirmed", "fastCheck"])
export type Basis = typeof Basis.Type

export const Said = Schema.Struct({
  id: UtteranceId,
  kind: SaidKind,
  text: Schema.String,
  /** Whom it answers: the claimant (flag), the asker (ack/take/answer), the speaker cut off (barge). */
  toward: Schema.String,
  /** The resource it is about, when there is one. */
  about: Schema.OptionFromNullOr(Schema.String),
  /** The claim's turn (flag, barge, update). */
  claim: Schema.OptionFromNullOr(Schema.Int),
  /** flag and barge only. */
  certainty: Schema.OptionFromNullOr(Certainty),
  basis: Schema.OptionFromNullOr(Basis)
})
export type Said = typeof Said.Type

export const JobKind = Schema.Literals(["confirm", "recheck", "answer"])
export type JobKind = typeof JobKind.Type

/** A job event: queued in the step that decided it, settled in the step that applied its result. */
export const JobNote = Schema.Struct({
  id: JobId,
  kind: JobKind,
  action: Schema.Literals(["queued", "settled"]),
  /** settled only. */
  outcome: Schema.optionalKey(Schema.Literals(["wrong", "right", "unknown", "answered", "failed", "timedOut"])),
  detail: Schema.String,
  by: Schema.optionalKey(Schema.String),
  /** settled only: from queued to settled, queue time included. */
  ms: Schema.optionalKey(Schema.Number)
})
export type JobNote = typeof JobNote.Type

export const CloseReason = Schema.Literals(["corrected", "parked", "overruled", "unsettled"])
export type CloseReason = typeof CloseReason.Type

export const Closes = Schema.Struct({
  why: CloseReason,
  /** The parked resource (why = parked), else the closed claim's resource. */
  resource: Schema.String,
  claims: Schema.Array(Schema.Int) // claim turns
})

export const Event = Schema.Struct({
  /** Monotone per Bridge; `changes` resumes from any seq (replay). */
  seq: Schema.Int,
  turn: Schema.Int,
  speaker: Schema.String,
  text: Schema.String,
  deciderMs: Schema.Number,
  route: Schema.OptionFromNullOr(Route),
  verdict: Schema.OptionFromNullOr(Verdict),
  checkEvidence: Schema.OptionFromNullOr(Schema.String),
  gate: Schema.OptionFromNullOr(G.GateDecision),
  gateScores: Schema.Record(Schema.String, Schema.Number),
  said: Schema.OptionFromNullOr(Said),
  escalations: Schema.Int,
  /** The claim this step was about. */
  claim: Schema.optionalKey(Schema.Int),
  /** Jobs queued or settled on this step (one heard line can start several second looks; was the singular `agent`). */
  jobs: Schema.Array(JobNote),
  closes: Schema.optionalKey(Schema.Array(Closes)),
  request: Schema.optionalKey(Schema.Struct({ id: RequestId, kind: Schema.Literals(["addressed", "open"]), speaker: Schema.String, text: Schema.String, status: Schema.String })),
  /** A line the policy chose but held: Egg Head is still speaking, no gap since its last line, or a heard line is still being analysed. */
  held: Schema.optionalKey(Schema.Literals(["speaking", "gap", "analysing"])),
  /** The turn's analysis failed (Decider or check error). The turn still gets exactly one event. */
  failed: Schema.optionalKey(Schema.String),
  /** Every note of the step (several items in one hear no longer overwrite each other). */
  notes: Schema.Array(Schema.String)
})
export type Event = typeof Event.Type
