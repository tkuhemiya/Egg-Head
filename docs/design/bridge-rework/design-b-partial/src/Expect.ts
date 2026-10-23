/**
 * Expect (delta): the vocabulary grows by exactly what the new Event fields expose.
 *
 *   Says        + certainty?: firm | tentative      (Event.said.certainty)
 *               + basis?: confirmed | fastCheck     (Event.said.basis)
 *               kind gains "update"
 *   Investigates  job gains "recheck"                (Event.jobs[].kind, action "queued")
 *   Closes      { resource, why? }                   (Event.closes[]) — new outcome: parking is observable
 *   never       + NeverOnCorrected                   no flag/barge/update about a claim after an event
 *                                                    closed it as corrected (Event.said.claim vs Event.closes)
 *
 * SaidKind is imported from Event.ts instead of re-declared (one list), and Judge.observe stops
 * deriving `about` from route maps and "take" from the request kind: it reads said.about,
 * said.toward and said.kind directly.
 */
import { Schema } from "effect"
import { Basis, Certainty, CloseReason, SaidKind } from "./Event.ts"

export const Says = Schema.TaggedStruct("Says", {
  kind: SaidKind,
  toward: Schema.optionalKey(Schema.String),
  about: Schema.optionalKey(Schema.String),
  certainty: Schema.optionalKey(Certainty),
  basis: Schema.optionalKey(Basis)
  // when: Timing (unchanged)
})

export const Investigates = Schema.TaggedStruct("Investigates", {
  job: Schema.Literals(["confirm", "recheck", "answer"])
})

export const Closes = Schema.TaggedStruct("Closes", {
  resource: Schema.String,
  why: Schema.optionalKey(CloseReason)
})

export const Outcome = Schema.Union([Says, Investigates, Closes])

// data/calls/barge-in.json, line 3, becomes:
//   "expect": [{ "_tag": "Says", "kind": "barge", "toward": "Priya", "about": "payments-api", "certainty": "firm", "basis": "confirmed" }]
// and a new data/calls/barge-while-checking.json scripts `"agent": { "confirmS": 6, "sees": { "payments-api": { ... healthy } } }`:
//   line 3 expects barge/tentative; the line after the agent reports expects Says{ kind: "update" }.
// data/calls/agent-fails.json: Investigates{recheck}, then Says{ kind: "flag", certainty: "tentative", basis: "fastCheck" }.
// A parking scenario: Closes{ resource: "auth-service", why: "parked" } and a later flag on orders-db.
