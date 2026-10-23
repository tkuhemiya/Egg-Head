/**
 * Speech: Egg Head's own voice, as the Bridge knows it.
 *
 * The Bridge cannot know how long a line takes to say; the caller can. So a line the Bridge
 * decides puts Speech into Speaking at once, and the caller reports `Bridge.finished(id)` when
 * the clip ends (or when it could not voice it). A Bridge-owned bound (`maxLineS`) ends
 * Speaking if the caller never reports, so a caller that does not voice (parity tests, the
 * smoke script) is never stuck.
 *
 *     Quiet --(policy picks a line that needs Bedrock)--> Writing{for} --(written)--> Speaking{id}
 *     Quiet --(policy picks a line written in code)--> Speaking{id}
 *     Speaking --(finished(id) | maxLineS)--> Quiet{endedAt}
 *
 * Owner's rule (one line per gap), all here:
 * - any Egg Head line counts as speaking (flag, ack, take, answer, barge, update);
 * - the next line needs a human turn heard after Egg Head finished, or `quietS` of silence
 *   since it finished;
 * - the 30 s cooldown is for unprompted lines only: a flag waits `cooldownS` after the last
 *   flag or barge (Gate.ts reads `sinceUnprompted`); asked-for lines never wait for it.
 * The humans in the demo hold while Speech is not Quiet (Call.ts reads `Bridge.speech`), which
 * replaces Floor.until and Floor.holdWhileWriting.
 */
import type { ClaimId, SaidKind, UtteranceId } from "./Event.ts"

export type Speech =
  | {
    readonly _tag: "Quiet"
    readonly endedAt: number // Clock seconds; -Infinity before Egg Head first speaks
    readonly humanSince: boolean // a human turn was heard after endedAt
  }
  | { readonly _tag: "Writing"; readonly claim: ClaimId; readonly since: number }
  | { readonly _tag: "Speaking"; readonly id: UtteranceId; readonly kind: SaidKind; readonly since: number }

export const SPEECH_TAGS: ReadonlyArray<Speech["_tag"]> = ["Quiet", "Writing", "Speaking"]

export const initial: Speech = { _tag: "Quiet", endedAt: Number.NEGATIVE_INFINITY, humanSince: true }

/** Unprompted lines (flag, barge) start the cooldown. Kept beside Speech, not inside it, so Quiet stays small. */
export interface Unprompted {
  readonly lastAt: number // -Infinity until the first flag or barge
}

export type Hold = "speaking" | "gap"

/** May Egg Head start an ordinary line now (not a barge)? undefined = yes; otherwise why it holds. */
export const gap = (s: Speech, now: number, t: { readonly quietS: number }): Hold | undefined => {
  throw new Error("not implemented")
  // Writing | Speaking -> "speaking"
  // Quiet && !humanSince && now - endedAt < quietS -> "gap"
}

/** A barge needs only that Egg Head is not already talking or writing. */
export const mayBarge = (s: Speech): boolean => s._tag === "Quiet"

export const speak = (s: Speech, id: UtteranceId, kind: SaidKind, now: number): Speech => {
  throw new Error("not implemented")
}
export const write = (s: Speech, claim: ClaimId, now: number): Speech => {
  throw new Error("not implemented")
}
/** finished(id): Speaking{id} -> Quiet. Any other id or state: unchanged (idempotent; a late report is harmless). */
export const finished = (s: Speech, id: UtteranceId, now: number): Speech => {
  throw new Error("not implemented")
}
/** A human turn was heard. */
export const heardHuman = (s: Speech): Speech => {
  throw new Error("not implemented")
}
/** Speaking past maxLineS, or Writing past the write deadline -> Quiet. */
export const expire = (s: Speech, now: number, t: { readonly maxLineS: number; readonly writeS: number }): Speech => {
  throw new Error("not implemented")
}
