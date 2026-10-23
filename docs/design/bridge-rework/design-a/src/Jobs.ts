/**
 * Jobs: every Investigator call is a row here, and every row ends.
 *
 * Phase has exactly one edge, Running -> Finished, taken by `finish` (idempotent: a second
 * finish returns None) or by `expire` (the Bridge-owned deadline, checked by the reducer on EVERY
 * input and also armed as a timer by the shell). Queue time behind the terminal agent counts,
 * because the deadline runs from dispatch. A job cannot be left Running.
 *
 * Fallback is part of the job model, not an `Effect.catch` in the shell: when a primary
 * (`via: "investigator"`) job finishes Failed/TimedOut, Step starts a `direct` job for the same
 * subject. When that fails too, the subject is told (claim: Closed{Unverifiable}; request:
 * Ready{Unable}). Neither path can strand a subject.
 */
import { Option, Schema } from "effect"
import { Status } from "./Checks.ts"
import { JobKind, Via } from "./Event.ts"
import { ClaimId, JobId, RequestId } from "./Ids.ts"

/**
 * What an Investigator can report. `Unknown` means no data settled it ("I could not tell"): this is a
 * normal answer, not an error. Claims close quietly (dashboard note); a question gets "I couldn't find out".
 */
export const Report = Schema.Union([
  Schema.TaggedStruct("Checked", { status: Status, fact: Schema.String, by: Schema.String }),
  Schema.TaggedStruct("Answered", { text: Schema.String, by: Schema.String }),
  Schema.TaggedStruct("Unknown", { why: Schema.String, by: Schema.String })
])
export type Report = typeof Report.Type

export const Outcome = Schema.Union([
  Schema.TaggedStruct("Reported", { report: Report }),
  Schema.TaggedStruct("Failed", { reason: Schema.String }),
  Schema.TaggedStruct("TimedOut", {}),
  Schema.TaggedStruct("Cancelled", {}) // the subject closed (claim corrected, parked) while it ran
])
export type Outcome = typeof Outcome.Type

export const Subject = Schema.Union([
  Schema.TaggedStruct("Claim", { id: ClaimId }),
  Schema.TaggedStruct("Request", { id: RequestId })
])
export type Subject = typeof Subject.Type

export const Job = Schema.Struct({
  id: JobId,
  kind: JobKind,
  via: Via,
  subject: Subject,
  startedAt: Schema.Number,
  deadlineAt: Schema.Number,
  phase: Schema.Union([
    Schema.TaggedStruct("Running", {}),
    Schema.TaggedStruct("Finished", { outcome: Outcome, at: Schema.Number })
  ])
})
export type Job = typeof Job.Type

export interface Jobs {
  readonly epoch: string
  readonly next: number
  readonly table: Readonly<Record<string, Job>>
}

export const empty = (_epoch: string): Jobs => { throw new Error("not implemented") }
/** Allocates the id and the deadline in the same transition that records the subject's new phase. */
export const start = (_j: Jobs, _spec: Pick<Job, "kind" | "via" | "subject">, _now: number, _deadlineS: number): readonly [Jobs, Job] => { throw new Error("not implemented") }
/** None when the job is not Running: duplicate or late deliveries are no-ops. */
export const finish = (_j: Jobs, _id: JobId, _outcome: Outcome, _now: number): Option.Option<readonly [Jobs, Job]> => { throw new Error("not implemented") }
export const expired = (_j: Jobs, _now: number): ReadonlyArray<Job> => { throw new Error("not implemented") }
export const running = (_j: Jobs): ReadonlyArray<Job> => { throw new Error("not implemented") }
