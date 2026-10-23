/**
 * Jobs: background Investigator work, as rows in Bridge state.
 *
 * A job is written into state (Queued) by the same atomic step that decided it, together with
 * the claim or request that records it. Nothing runs it yet. The Bridge's runner fiber watches
 * committed state and, for each Queued job, commits Queued -> Running and only then forks the
 * work. So a job can never run without the state that records it (review finding 4), and a
 * crash between "decided" and "started" leaves a Queued row the runner picks up, not a ghost.
 *
 * Every job ends in a terminal state:
 * - its result (Reported), or its failure (Failed), applied as a JobDone input;
 * - or the Bridge's own deadline: `expire` runs at the top of every reduce (ticks arrive every
 *   250 ms), and moves any Queued or Running job past `deadline` to TimedOut. The deadline
 *   counts from when the job was queued, so time spent waiting behind other jobs counts
 *   (finding 9). The fiber is also given `Effect.timeout(deadline - now)` so it stops working.
 * A result for a job that is no longer Running (timed out, or a duplicate) is a no-op.
 */
import { Option } from "effect"
import type { ClaimId, JobId, JobKind, RequestId } from "./Event.ts"
import type { AnswerResult, Finding } from "./Investigator.ts"

export type JobFor =
  | { readonly _tag: "Claim"; readonly claim: ClaimId }
  | { readonly _tag: "Request"; readonly request: RequestId }

export type JobResult =
  | { readonly _tag: "Finding"; readonly finding: Finding; readonly by: string }
  | { readonly _tag: "Answer"; readonly answer: AnswerResult; readonly by: string }

export type JobStatus =
  | { readonly _tag: "Queued" }
  | { readonly _tag: "Running"; readonly startedAt: number }
  | { readonly _tag: "Reported"; readonly result: JobResult; readonly at: number }
  | { readonly _tag: "Failed"; readonly cause: string; readonly at: number }
  | { readonly _tag: "TimedOut"; readonly at: number }

export const JOB_TAGS: ReadonlyArray<JobStatus["_tag"]> = ["Queued", "Running", "Reported", "Failed", "TimedOut"]

export interface Job {
  readonly id: JobId
  readonly kind: JobKind // confirm | recheck | answer
  readonly for: JobFor
  readonly queuedAt: number // Clock seconds
  readonly deadline: number // queuedAt + Tuning.jobs[kind]
  readonly status: JobStatus
}

export const isOpen = (j: Job): boolean => j.status._tag === "Queued" || j.status._tag === "Running"

export const queue = (jobs: ReadonlyArray<Job>, job: Omit<Job, "status">): ReadonlyArray<Job> => {
  throw new Error("not implemented")
}

/** Queued -> Running. The runner forks the work only when this returned Some (once per job). */
export const start = (jobs: ReadonlyArray<Job>, id: JobId, now: number): Option.Option<readonly [ReadonlyArray<Job>, Job]> => {
  throw new Error("not implemented")
}

/** Running -> Reported | Failed. None when the job is not Running (late or duplicate result). */
export const finish = (
  jobs: ReadonlyArray<Job>,
  id: JobId,
  outcome: { readonly _tag: "Reported"; readonly result: JobResult } | { readonly _tag: "Failed"; readonly cause: string },
  now: number
): Option.Option<readonly [ReadonlyArray<Job>, Job]> => {
  throw new Error("not implemented")
}

/** Every open job past its deadline -> TimedOut. Returns the jobs that just timed out, so their owners settle in the same step. */
export const expire = (jobs: ReadonlyArray<Job>, now: number): readonly [ReadonlyArray<Job>, ReadonlyArray<Job>] => {
  throw new Error("not implemented")
}

/** The runner's view: jobs committed as Queued, oldest first. */
export const queued = (jobs: ReadonlyArray<Job>): ReadonlyArray<Job> => jobs.filter((j) => j.status._tag === "Queued")
