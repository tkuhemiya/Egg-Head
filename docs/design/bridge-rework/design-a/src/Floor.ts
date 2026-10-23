/**
 * Floor: who is talking, including Egg Head. Its own speech is an input.
 *
 * Egg Head cannot know how long its line lasts. Phases:
 *   Open ──(Agenda/barge decides)──▶ Composing{id, draft}   only when a Writer must write the line
 *   Open|Composing ──▶ Speaking{id, safetyUntil}             the caller is voicing it
 *   Speaking ──(Input.SpeechEnded from the caller | safetyUntil passes)──▶ Open, lastEndedAt = now
 *
 * `safetyUntil` (Tuning.floor.maxSpeechS) is Bridge-owned so a caller that never reports cannot wedge
 * the floor. Composing has its own deadline; on expiry the code line is used.
 *
 * One line per gap (owner decision 3): `mayStart` needs phase Open and (a human line has been heard
 * since Egg Head's last line was decided, or Tuning.floor.quietAfterSpeechS of silence since it
 * ENDED). Cooldown (30 s) is not here: it stays in Gate, for unprompted lines only; answers and acks
 * never consult it.
 */
import { Option, Schema } from "effect"
import { SpeechId } from "./Ids.ts"
import type { Tuning } from "./Tuning.ts"

export const Phase = Schema.Union([
  Schema.TaggedStruct("Open", {}),
  Schema.TaggedStruct("Composing", { id: SpeechId, since: Schema.Number, until: Schema.Number, draft: Schema.Unknown /* the Event so far (Event.ts), published when composed */ }),
  Schema.TaggedStruct("Speaking", { id: SpeechId, since: Schema.Number, safetyUntil: Schema.Number })
])
export type Phase = typeof Phase.Type

export interface Floor {
  readonly phase: Phase
  readonly lastEndedAt: Option.Option<number>
  readonly turnAtLastLine: Option.Option<number> // turns.length when Egg Head's last line was decided
  readonly lastUnpromptedAt: Option.Option<number> // flags and barges only: feeds Gate's cooldown
  readonly seq: number
}
export const open: Floor = { phase: { _tag: "Open" }, lastEndedAt: Option.none(), turnAtLastLine: Option.none(), lastUnpromptedAt: Option.none(), seq: 0 }

export type May = { readonly ok: true } | { readonly ok: false; readonly why: "speaking" | "composing" | "oneLinePerGap" }
export const mayStart = (_f: Floor, _turns: number, _now: number, _silenceS: number, _t: Tuning): May => { throw new Error("not implemented") }
/** min(reported VAD silence, time since Egg Head's line ended): the runner's silence counter keeps running while Egg Head talks; this does not. 0 while Composing/Speaking. */
export const silence = (_f: Floor, _now: number, _reportedS: number): number => { throw new Error("not implemented") }
export const take = (_f: Floor, _speech: SpeechId, _unprompted: boolean, _turns: number, _now: number, _t: Tuning, _needsWriter: boolean): Floor => { throw new Error("not implemented") }
/** Idempotent; ignored unless `id` is the current Speaking. */
export const ended = (_f: Floor, _id: SpeechId, _now: number): Floor => { throw new Error("not implemented") }
export const expire = (_f: Floor, _now: number): Floor => { throw new Error("not implemented") }
