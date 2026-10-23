/**
 * Jobs: every Investigator call is a row here, and every row ends.
 * Running → Finished, taken by `finish` (idempotent) or `expire` (Bridge-owned deadline).
 */
import { Option, Schema } from "effect"
import { Status } from "./Checks.ts"
import { ClaimId, JobId, jobId as mintJob, RequestId } from "./Ids.ts"

export const Via = Schema.Literals(["investigator", "direct"])
export type Via = typeof Via.Type

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
  Schema.TaggedStruct("Cancelled", {})
])
export type Outcome = typeof Outcome.Type

export const Subject = Schema.Union([
  Schema.TaggedStruct("Claim", { id: ClaimId }),
  Schema.TaggedStruct("Request", { id: RequestId })
])
export type Subject = typeof Subject.Type

export const JOB_TAGS = ["Running", "Finished"] as const

export const Job = Schema.Struct({
  id: JobId,
  kind: Schema.Literals(["confirm", "recheck", "answer"]),
  via: Via,
  subject: Subject,
  startedAt: Schema.Number,
  deadlineAt: Schema.Number,
  attempt: Schema.Int, // 1 = primary, 2 = direct fallback
  phase: Schema.Union([
    Schema.TaggedStruct("Running", {}),
    Schema.TaggedStruct("Finished", { outcome: Outcome, at: Schema.Number })
  ])
})
export type Job = typeof Job.Type
export type JobKindName = Job["kind"]

export interface Jobs {
  readonly epoch: string
  readonly next: number
  readonly table: Readonly<Record<string, Job>>
}

export const empty = (epoch: string): Jobs => ({ epoch, next: 1, table: {} })

export const start = (
  j: Jobs,
  spec: Pick<Job, "kind" | "via" | "subject" | "attempt">,
  now: number,
  deadlineS: number
): readonly [Jobs, Job] => {
  const id = mintJob(j.epoch, j.next)
  const job: Job = {
    id,
    ...spec,
    startedAt: now,
    deadlineAt: now + deadlineS,
    phase: { _tag: "Running" }
  }
  return [{ ...j, next: j.next + 1, table: { ...j.table, [id]: job } }, job]
}

export const finish = (j: Jobs, id: JobId, outcome: Outcome, now: number): Option.Option<readonly [Jobs, Job]> => {
  const cur = j.table[id]
  if (cur === undefined || cur.phase._tag !== "Running") return Option.none()
  const job: Job = { ...cur, phase: { _tag: "Finished", outcome, at: now } }
  return Option.some([{ ...j, table: { ...j.table, [id]: job } }, job])
}

export const expired = (j: Jobs, now: number): ReadonlyArray<Job> =>
  Object.values(j.table).filter((job) => job.phase._tag === "Running" && now >= job.deadlineAt)

export const running = (j: Jobs): ReadonlyArray<Job> =>
  Object.values(j.table).filter((job) => job.phase._tag === "Running")

export const get = (j: Jobs, id: JobId): Job | undefined => j.table[id]
