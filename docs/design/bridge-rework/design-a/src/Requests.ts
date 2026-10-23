/**
 * Requests: something asked of Egg Head, or of the call and left hanging. Explicit machine; single
 * writer of `State.requests`.
 *
 *   Listening ──(ready to reply / nobody answered in openSilenceS; says the ack)──▶ Working{job}
 *   Listening ──(someone else answers an open question)──▶ Closed{dropped}
 *   Working ──(job Reported Answered)──▶ Ready{Found}
 *   Working ──(job Reported Unknown)───▶ Ready{Unable "could not tell"}   says "I couldn't find out"
 *   Working ──(primary Failed/TimedOut)▶ Working{direct job}
 *   Working ──(direct Failed/TimedOut)─▶ Ready{Unable}                     total: an ack is always answered
 *   Ready ──(said at a gap)──▶ Closed{answered}
 */
import { Option, Schema } from "effect"
import { JobId, RequestId } from "./Ids.ts"
import type { Ctx, State, Stepped } from "./State.ts"
import type { Outcome } from "./Jobs.ts"
import type { Verdict } from "./Judgments.ts"

export const Answer = Schema.Union([
  Schema.TaggedStruct("Found", { text: Schema.String }),
  Schema.TaggedStruct("Unable", { reason: Schema.Literals(["unknown", "failed", "noResource"]) })
])
export type Answer = typeof Answer.Type

export const Phase = Schema.Union([
  Schema.TaggedStruct("Listening", {}),
  Schema.TaggedStruct("Working", { job: JobId }), // entering Working IS the ack
  Schema.TaggedStruct("Ready", { answer: Answer }),
  Schema.TaggedStruct("Closed", { why: Schema.Literals(["answered", "dropped"]), note: Schema.String })
])
export type Phase = typeof Phase.Type

export const Request = Schema.Struct({
  id: RequestId,
  kind: Schema.Literals(["addressed", "open"]),
  speaker: Schema.String,
  text: Schema.String, // joined across the speaker's segments
  turn: Schema.Int,
  phase: Phase,
  note: Schema.String
})
export type Request = typeof Request.Type
export type Requests = ReadonlyArray<Request>

/** Open a request from this line (addressed / open question), merge a continuation, or drop an open one another speaker answered (seam: answers). Off when !policy.conversation. */
export const intake = (_s: State, _line: unknown, _verdicts: ReadonlyArray<Verdict>, _ctx: Ctx): Stepped<Pick<State, "requests">> => { throw new Error("not implemented") }
export const worked = (_s: State, _id: RequestId, _ctx: Ctx): Stepped<Pick<State, "requests" | "jobs">> => { throw new Error("not implemented") }
export const jobFinished = (_s: State, _job: JobId, _o: Outcome, _ctx: Ctx): Stepped<Pick<State, "requests" | "jobs">> => { throw new Error("not implemented") }
export const answered = (_rs: Requests, _id: RequestId): Requests => { throw new Error("not implemented") }
export const live = (_rs: Requests): Requests => { throw new Error("not implemented") }
