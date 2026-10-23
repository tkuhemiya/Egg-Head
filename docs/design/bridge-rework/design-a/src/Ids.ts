/** Ids and small closed vocabularies shared by every module. A leaf: imports nothing from src/. */
import { Schema } from "effect"

export const ClaimId = Schema.String.pipe(Schema.brand("ClaimId")) // `${turn}:${check}:${resource}`
export type ClaimId = typeof ClaimId.Type
export const JobId = Schema.String.pipe(Schema.brand("JobId")) // `${epoch}/${n}`; epoch is fresh per Bridge, so a stale report from an earlier run can never match
export type JobId = typeof JobId.Type
export const SpeechId = Schema.String.pipe(Schema.brand("SpeechId")) // `${epoch}/s${n}`
export type SpeechId = typeof SpeechId.Type
export const RequestId = Schema.Int.pipe(Schema.brand("RequestId"))
export type RequestId = typeof RequestId.Type

export const claimId = (_turn: number, _check: string, _resource: string): ClaimId => { throw new Error("not implemented") }

/** Who vouches for a claim. `confirmed` is only ever produced from a successful investigator report. */
export const Basis = Schema.Literals(["confirmed", "fastCheck"])
export type Basis = typeof Basis.Type

/** How Egg Head words it. Derived from Voice, never chosen by a caller. */
export const Certainty = Schema.Literals(["firm", "tentative"])
export type Certainty = typeof Certainty.Type

/**
 * firm            "Quick flag, Sam: orders-db is healthy."          (confirmed, or direct mode where the fast check is final)
 * doubleChecking  "My quick check shows ..., I'm double-checking."  (tentative barge: a Job is running or was started with the line)
 * couldNotConfirm "I could not confirm further, but ..."            (second look failed; fast check re-run still contradicts)
 */
export const Voice = Schema.Literals(["firm", "doubleChecking", "couldNotConfirm"])
export type Voice = typeof Voice.Type
export const certaintyOf = (v: Voice): Certainty => (v === "firm" ? "firm" : "tentative")

export const RepairedBy = Schema.Literals(["ledger", "keyword", "decider"])
export type RepairedBy = typeof RepairedBy.Type
