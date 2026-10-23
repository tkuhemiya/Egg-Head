/**
 * Requests: something asked of Egg Head by name ("addressed"), or a question to the call that
 * Egg Head may take ("open"). Moved out of Conversation.ts, which keeps the questions, the
 * reply-timing rule and the spoken lines.
 *
 *    addressed:  Listening --(speaker finished; ack said)--> Working{job} --(job settles, any way)--> Ready{answer}
 *    open:       Listening --(nobody answered in 2.5 s; take said)--> Working{job} --> Ready{answer}
 *                Listening --(Reading: someone else answered it)--> Dropped{answeredByCall}
 *                Listening --(the asker asks something else)--> Dropped{movedOn}
 *    Ready --(said at a gap)--> Answered
 *
 * AckIsAnswered holds by construction: Working has exactly one way out (its job settles), every
 * job settles (Jobs.ts: result, failure or the Bridge's own deadline), and every settlement maps
 * to Ready: an answer, or "I couldn't find that out" (Answer.Unknown). Ready is owed: the policy
 * says it at the next gap and the cooldown never holds it.
 */
import { Option } from "effect"
import type { JobId, RequestId } from "./Event.ts"
import type { AnswerResult } from "./Investigator.ts"

export type RequestStatus =
  | { readonly _tag: "Listening" }
  | { readonly _tag: "Working"; readonly job: JobId }
  | { readonly _tag: "Ready"; readonly answer: AnswerResult }
  | { readonly _tag: "Answered" }
  | { readonly _tag: "Dropped"; readonly why: "answeredByCall" | "movedOn" }

export type RequestTag = RequestStatus["_tag"]
export const REQUEST_TAGS: ReadonlyArray<RequestTag> = ["Listening", "Working", "Ready", "Answered", "Dropped"]

export interface Request {
  readonly id: RequestId
  readonly kind: "addressed" | "open"
  readonly speaker: string
  /** The whole question, joined across the speaker's segments. */
  readonly text: string
  readonly turn: number // first turn of the question
  readonly status: RequestStatus
}

/** What one heard line means for requests. Computed by Observe (Decider + code), applied here. */
export type LineAsk =
  | { readonly _tag: "Continues" } // the addressed speaker is still talking: append their words
  | { readonly _tag: "Addresses"; readonly p: number } // names Egg Head and Decider addr >= tuning
  | { readonly _tag: "Asks"; readonly p: number } // a "?", Decider ask >= tuning, not a routed claim
  | { readonly _tag: "Other" }

/** Apply one heard line. `answered`: the seam's verdict per open Listening request (Reading.answers). */
export const hear = (
  requests: ReadonlyArray<Request>,
  line: { readonly turn: number; readonly speaker: string; readonly text: string; readonly ask: LineAsk },
  answered: ReadonlyMap<RequestId, boolean>,
  newId: RequestId
): ReadonlyArray<Request> => {
  throw new Error("not implemented")
  // Continues -> append text to the addressed Listening request of this speaker
  // Addresses / Asks -> new Listening request; the speaker's own open Listening -> Dropped{movedOn}
  // every open Listening request the seam says this line answered -> Dropped{answeredByCall}
}

/** Ack or take: Listening -> Working{job}. No-op unless Listening (a repeated step cannot ack twice). */
export const work = (r: Request, job: JobId): Request => {
  throw new Error("not implemented")
}

/** The answer job settled, whatever happened. Failed or timed out -> Ready{Unknown}. */
export const settleJob = (r: Request, job: JobId, result: Option.Option<AnswerResult>): Request => {
  throw new Error("not implemented")
}

export const answered = (r: Request): Request => {
  throw new Error("not implemented") // Ready -> Answered
}

/** The oldest Ready request: owed, said before any flag. */
export const owed = (requests: ReadonlyArray<Request>): Option.Option<Request> => {
  throw new Error("not implemented")
}

/** The Listening request the policy may ack or take now, if any (oldest first). */
export const listening = (requests: ReadonlyArray<Request>): Option.Option<Request> => {
  throw new Error("not implemented")
}
