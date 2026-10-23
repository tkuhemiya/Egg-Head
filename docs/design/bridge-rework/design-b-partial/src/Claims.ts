/**
 * Claims: what someone on the call said that a fast check contradicted, and its lifecycle.
 * Replaces Ledger.ts (the `raised` boolean plus the optional `agent` string become one status).
 *
 *                       admit (fast check contradicts)
 *                                   |
 *          no Investigator          v           with an Investigator
 *     Confirmed{fastCheck} <---- Contradicted ----> (survives one turn, or a barge) ----> Checking{job}
 *                                                                                           |
 *          job: wrong                   -> Confirmed{confirmed}                             |
 *          job: right                   -> Closed{overruled}   (or Correcting, if barged)   |
 *          job: unknown                 -> Closed{unsettled}   (or Correcting, if barged)   |
 *          job: failed / timed out      -> Checking{recheck}  -- wrong -> Confirmed{fastCheck}
 *                                                             -- right -> Closed{overruled} / Correcting
 *                                                             -- else  -> Closed{unsettled} / Spoken
 *     Confirmed --flag at a gap--> Spoken           Contradicted|Checking|Confirmed --barge--> Spoken / Checking{barged}
 *     Correcting --update at a gap--> Closed        any live status --corrected / parked--> Closed
 *
 * Every transition is a pure function `Claim -> Claim` (or a no-op when the status does not
 * allow it), so a late or repeated input converges: a job result for a claim that is no longer
 * Checking that job changes nothing (make-operations-idempotent).
 */
import { Option } from "effect"
import type { Status } from "./Checks.ts"
import type { Basis, Certainty, ClaimId, CloseReason, JobId } from "./Event.ts"
import type { Finding } from "./Investigator.ts"
import type { RepairedBy } from "./Gate.ts"

export type ClaimStatus =
  /** Fast check disagrees. With an Investigator: waiting one turn to see if the call corrects it. */
  | { readonly _tag: "Contradicted" }
  /** Second look (`confirm`) or the fast re-run after it failed (`recheck`) is running. */
  | { readonly _tag: "Checking"; readonly job: JobId; readonly recheck: boolean; readonly barged: boolean }
  /** Gateable. `basis` says how it got here; the flag's wording and certainty follow from it. */
  | { readonly _tag: "Confirmed"; readonly basis: Basis; readonly fact: string }
  /** Egg Head said it. */
  | { readonly _tag: "Spoken"; readonly how: "flag" | "barge"; readonly certainty: Certainty }
  /** A tentative barge the second look did not bear out: Egg Head owes the call an update. */
  | { readonly _tag: "Correcting"; readonly why: "overruled" | "unsettled"; readonly fact: string }
  /** Done without (further) speech. */
  | { readonly _tag: "Closed"; readonly why: CloseReason; readonly by: string }

export type ClaimTag = ClaimStatus["_tag"]
/** The one list of tags; test/SpecSync.test.ts holds spec/Bridge.tla's ClaimStatuses to it. */
export const CLAIM_TAGS: ReadonlyArray<ClaimTag> = ["Contradicted", "Checking", "Confirmed", "Spoken", "Correcting", "Closed"]

export interface Claim {
  readonly id: ClaimId
  readonly turn: number
  readonly speaker: string
  readonly text: string
  readonly check: string
  readonly resource: string
  readonly asserted: Option.Option<string>
  /** What the fast check returned. */
  readonly fast: { readonly status: Status; readonly evidence: string }
  readonly status: ClaimStatus
}

/** Still in play: the call may correct or park it, the gate may raise it, a partial may barge on it. */
export const isLive = (c: Claim): boolean =>
  c.status._tag === "Contradicted" || c.status._tag === "Checking" || c.status._tag === "Confirmed"

/** How a new contradicted claim starts (the only place the two modes differ for claims). */
export type Admit = "gate" | "secondLook"

/** Add a contradicted claim. No-op when a live claim has the same check and resource (today's dedupe). */
export const admit = (claims: ReadonlyArray<Claim>, c: Omit<Claim, "status">, how: Admit): ReadonlyArray<Claim> => {
  throw new Error("not implemented")
  // how === "gate"       -> Confirmed{ basis: "fastCheck", fact: factOf(c) }   (no Investigator: today's flagger)
  // how === "secondLook" -> Contradicted
}

/** Per-claim judgments from the seam (Reading.ts) and from code (a later supporting check). */
export interface ClaimReading {
  readonly corrected: Option.Option<RepairedBy> // ledger | keyword | decider, over Tuning thresholds
  readonly parked: boolean
}

/** Close a live claim the call corrected or parked. Corrected wins over parked (it says more). */
export const settleReading = (c: Claim, r: ClaimReading): Claim => {
  throw new Error("not implemented")
}

/** With an Investigator: a Contradicted claim from an earlier turn that was not corrected gets its second look. */
export const startSecondLook = (c: Claim, job: JobId, currentTurn: number): Claim => {
  throw new Error("not implemented")
  // only Contradicted && c.turn < currentTurn -> Checking{ job, recheck: false, barged: false }
}

/**
 * The confirm or recheck job settled. `result` is Failed for an error or a Bridge deadline.
 * Returns the claim and whether a recheck job must be queued (confirm failed).
 */
export const settleJob = (
  c: Claim,
  job: JobId,
  result: { readonly _tag: "Finding"; readonly finding: Finding; readonly stillWrong: boolean } | { readonly _tag: "Failed" },
  recheckJob: JobId
): { readonly claim: Claim; readonly recheck: boolean } => {
  throw new Error("not implemented")
  // not Checking{job} -> unchanged (late result; idempotent)
  // Found & stillWrong   -> recheck ? Confirmed{fastCheck} : Confirmed{confirmed}; if barged -> Spoken{barge, tentative}
  // Found & !stillWrong  -> barged ? Correcting{overruled} : Closed{overruled}
  // Unknown              -> barged ? Correcting{unsettled} : Closed{unsettled}   ("stays quiet; dashboard note")
  // Failed, !recheck     -> Checking{recheckJob, recheck: true, barged}, recheck: true
  // Failed, recheck      -> barged ? Spoken{barge, tentative} : Closed{unsettled}
}

/**
 * May Egg Head cut someone off over this claim, and how sure may it sound?
 * The guard the TLA+ rules NeverFirmOnUnconfirmed and NeverSaysCorrected rest on:
 * - Confirmed{confirmed}               -> firm
 * - Contradicted, Checking (not barged), Confirmed{fastCheck} -> tentative
 * - anything else (Spoken, Correcting, Closed: corrected, parked, overruled) -> none
 */
export const bargeCertainty = (c: Claim): Option.Option<Certainty> => {
  throw new Error("not implemented")
}

/** After a barge. A Contradicted claim starts its second look now (`job`): the barge promised it. */
export const barged = (c: Claim, certainty: Certainty, job: JobId): Claim => {
  throw new Error("not implemented")
  // firm                       -> Spoken{barge, firm}
  // tentative, Contradicted    -> Checking{job, recheck: false, barged: true}
  // tentative, Checking        -> Checking{..., barged: true}
  // tentative, Confirmed{fastCheck} -> Spoken{barge, tentative}
}

export const flagged = (c: Claim, certainty: Certainty): Claim => {
  throw new Error("not implemented")
}
export const updated = (c: Claim): Claim => {
  throw new Error("not implemented") // Correcting{why} -> Closed{why}
}

/** The claim the flag gate looks at: the oldest Confirmed one. */
export const gateable = (claims: ReadonlyArray<Claim>): Option.Option<Claim> => {
  throw new Error("not implemented")
}

/** The claim a partial names, for a barge: the oldest live claim on a named resource that may be barged. */
export const bargeTarget = (claims: ReadonlyArray<Claim>, named: ReadonlySet<string>): Option.Option<readonly [Claim, Certainty]> => {
  throw new Error("not implemented")
}

/** The claim's evidence as one spoken fact, when no model wrote one. */
export const factOf = (c: Pick<Claim, "resource" | "fast">): string => `${c.resource} is ${c.fast.status}, ${c.fast.evidence}`
