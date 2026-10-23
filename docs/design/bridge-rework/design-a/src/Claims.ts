/**
 * Claims: the lifecycle of a contradicted claim, as an explicit state machine. Replaces Ledger.ts.
 * Single writer of `State.claims`.
 *
 *   Fresh ──(survives a turn)──▶ Checking{job} ──Checked, still wrong──▶ Standing{confirmed, firm}
 *     │                             │   │  Checked, right ────────────▶ Closed{Overruled}
 *     │                             │   │  Unknown ───────────────────▶ Closed{Undetermined}   quiet + note
 *     │                             │   └  Failed/TimedOut ─▶ Checking{recheck job, direct}
 *     │                             │         Checked, still wrong ──▶ Standing{fastCheck, couldNotConfirm}
 *     │                             │         Checked, right ─────────▶ Closed{Overruled}
 *     │                             │         Unknown / Failed ───────▶ Closed{Unverifiable}
 *   direct mode (no Investigator): born Standing{fastCheck, firm}; the other phases are unreachable.
 *   Any non-Closed phase ──(call corrects it / parks its resource)──▶ Closed{Corrected|Parked}, job Cancelled.
 *   Any of Fresh|Checking|Standing ──(barge)──▶ same phase + toldTentatively, or Closed{Spoken}
 *   Standing ──(flag at a gap)──▶ Closed{Spoken}
 *
 * Invariants by type: only `bargeable` / `flaggable` claims can be handed to Floor.take; `Standing.basis`
 * "confirmed" is built only in `jobReported` from a Checked report of a primary job. Phase tags are
 * the TLA+ claim statuses (spec/Bridge.tla header table; test/Laws.test.ts fails if they drift).
 */
import { Option, Schema } from "effect"
import { Status } from "./Checks.ts"
import { Basis, ClaimId, RepairedBy, SpeechId, Voice, Certainty } from "./Ids.ts"
import type { Stepped, Ctx, State } from "./State.ts"
import type { Outcome } from "./Jobs.ts"
import type { Verdict } from "./Judgments.ts"

export const Closure = Schema.Union([
  Schema.TaggedStruct("Spoken", { speech: SpeechId, as: Schema.Literals(["flag", "barge"]), certainty: Certainty }),
  Schema.TaggedStruct("Corrected", { by: RepairedBy }),
  Schema.TaggedStruct("Overruled", { fact: Schema.String }), // second look found the claim right
  Schema.TaggedStruct("Parked", {}),
  Schema.TaggedStruct("Undetermined", { why: Schema.String }), // Investigator said Unknown: no data settled it
  Schema.TaggedStruct("Unverifiable", { why: Schema.String }) // second look and fast re-check both failed
])
export type Closure = typeof Closure.Type

export const Phase = Schema.Union([
  Schema.TaggedStruct("Fresh", {}),
  Schema.TaggedStruct("Checking", { job: Schema.String }),
  Schema.TaggedStruct("Standing", { basis: Basis, voice: Schema.Literals(["firm", "couldNotConfirm"]), fact: Schema.String }),
  Schema.TaggedStruct("Closed", { why: Closure })
])
export type Phase = typeof Phase.Type

export const Claim = Schema.Struct({
  id: ClaimId,
  speaker: Schema.String,
  claim: Schema.String,
  check: Schema.String,
  resource: Schema.String,
  asserted: Schema.OptionFromNullOr(Schema.String),
  status: Status, // what the fast check returned
  evidence: Schema.String,
  turn: Schema.Int,
  phase: Phase,
  /** Egg Head already said it tentatively (a barge); the promise "I'm double-checking" is a running job. */
  toldTentatively: Schema.Boolean,
  /** Said tentatively, then the claim turned out right or unverifiable: Agenda owes the call a retraction. */
  retractionOwed: Schema.Boolean
})
export type Claim = typeof Claim.Type
export type Claims = ReadonlyArray<Claim>
type Tag<T extends Phase["_tag"]> = Claim & { readonly phase: Extract<Phase, { _tag: T }> }
export type Standing = Tag<"Standing">
export type Bargeable = Tag<"Fresh"> | Tag<"Checking"> | Tag<"Standing">

export const isOpen = (c: Claim): boolean => c.phase._tag !== "Closed"
export const standing = (_cs: Claims): ReadonlyArray<Standing> => { throw new Error("not implemented") }
/** Not Closed, and not already told tentatively unless it has since been confirmed. */
export const bargeable = (_c: Claim): _c is Bargeable => { throw new Error("not implemented") }
/** The voice a barge on this claim must use: firm only for Standing{confirmed}; otherwise doubleChecking. */
export const bargeVoice = (_c: Bargeable): Voice => { throw new Error("not implemented") }

/** A new contradicted claim. Dedupes on check+resource against open claims. Born Standing in direct mode, Fresh otherwise. */
export const observe = (_s: State, _new: Omit<Claim, "phase" | "toldTentatively" | "retractionOwed" | "id">, _ctx: Ctx): Stepped<Pick<State, "claims">> => { throw new Error("not implemented") }

/**
 * Apply the seam's verdicts for this line. Per claim: corrects >= tuning.gate.selfRepaired closes it
 * (Corrected); else parks >= tuning.parked closes it (Parked). Only that claim: a parking line about
 * orders-db leaves a claim about payments-api alone. Closing a Checking claim emits CancelJob.
 */
export const judge = (_s: State, _v: ReadonlyArray<Verdict>, _ctx: Ctx): Stepped<Pick<State, "claims" | "jobs">> => { throw new Error("not implemented") }

/** Fresh claims older than this turn that survived `judge` get their second look (policy.secondLook). Job started in the same transition. */
export const secondLook = (_s: State, _ctx: Ctx): Stepped<Pick<State, "claims" | "jobs">> => { throw new Error("not implemented") }

/** The one place a job outcome becomes a claim phase (the diagram above). Idempotent: ignored unless the claim is Checking on this job. */
export const jobFinished = (_s: State, _job: string, _outcome: Outcome, _ctx: Ctx): Stepped<Pick<State, "claims" | "jobs">> => { throw new Error("not implemented") }

/** Egg Head spoke about the claim. Flag -> Closed{Spoken}. Tentative barge -> toldTentatively, and a confirm job if none runs (so "I'm double-checking" is true). */
export const spoken = (_s: State, _id: ClaimId, _how: { kind: "flag" | "barge"; voice: Voice; speech: SpeechId }, _ctx: Ctx): Stepped<Pick<State, "claims" | "jobs">> => { throw new Error("not implemented") }
export const retracted = (_cs: Claims, _id: ClaimId): Claims => { throw new Error("not implemented") }
