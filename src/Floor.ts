/**
 * Floor: who is talking, including Egg Head. Its own speech is an input.
 */
import { Option } from "effect"
import { SpeechId, speechId } from "./Ids.ts"
import type { Event } from "./Event.ts"
import type { TuningShape } from "./Tuning.ts"

export const FLOOR_TAGS = ["Open", "Composing", "Speaking"] as const

export type Phase =
  | { readonly _tag: "Open" }
  | { readonly _tag: "Composing"; readonly id: SpeechId; readonly since: number; readonly until: number; readonly draft: Event }
  | { readonly _tag: "Speaking"; readonly id: SpeechId; readonly since: number; readonly safetyUntil: number }

export interface Floor {
  readonly phase: Phase
  readonly lastEndedAt: Option.Option<number>
  readonly turnAtLastLine: Option.Option<number>
  readonly lastUnpromptedAt: Option.Option<number>
  readonly seq: number
}

export const open: Floor = {
  phase: { _tag: "Open" },
  lastEndedAt: Option.none(),
  turnAtLastLine: Option.none(),
  lastUnpromptedAt: Option.none(),
  seq: 0
}

export type May =
  | { readonly ok: true }
  | { readonly ok: false; readonly why: "speaking" | "composing" | "oneLinePerGap" }

export const mayStart = (f: Floor, turns: number, now: number, t: TuningShape): May => {
  if (f.phase._tag === "Speaking") return { ok: false, why: "speaking" }
  if (f.phase._tag === "Composing") return { ok: false, why: "composing" }
  if (Option.isNone(f.turnAtLastLine)) return { ok: true }
  if (turns > f.turnAtLastLine.value) return { ok: true }
  const ended = Option.getOrElse(f.lastEndedAt, () => now)
  if (now - ended >= t.floor.quietAfterSpeechS) return { ok: true }
  return { ok: false, why: "oneLinePerGap" }
}

export const silence = (f: Floor, now: number, reportedS: number): number => {
  if (f.phase._tag !== "Open") return 0
  if (Option.isNone(f.lastEndedAt)) return reportedS
  return Math.min(reportedS, Math.max(0, now - f.lastEndedAt.value))
}

export const take = (
  f: Floor,
  epoch: string,
  unprompted: boolean,
  turns: number,
  now: number,
  t: TuningShape,
  needsWriter: boolean,
  draft: Event
): Floor => {
  const seq = f.seq + 1
  const id = speechId(epoch, seq)
  const held: Event = { ...draft, speech: draft.speech ?? Option.none(), moves: draft.moves ?? [] }
  const phase: Phase = needsWriter
    ? { _tag: "Composing", id, since: now, until: now + t.floor.composeDeadlineS, draft: held }
    : { _tag: "Speaking", id, since: now, safetyUntil: now + t.floor.maxSpeechS }
  return {
    phase,
    lastEndedAt: f.lastEndedAt,
    turnAtLastLine: Option.some(turns),
    lastUnpromptedAt: unprompted ? Option.some(now) : f.lastUnpromptedAt,
    seq
  }
}

/** After compose: Composing → Speaking. */
export const composed = (f: Floor, id: SpeechId, now: number, t: TuningShape): Floor => {
  if (f.phase._tag !== "Composing" || f.phase.id !== id) return f
  return { ...f, phase: { _tag: "Speaking", id, since: now, safetyUntil: now + t.floor.maxSpeechS } }
}

export const ended = (f: Floor, id: SpeechId, now: number): Floor => {
  if (f.phase._tag !== "Speaking" || f.phase.id !== id) return f
  return { ...f, phase: { _tag: "Open" }, lastEndedAt: Option.some(now) }
}

export const expire = (f: Floor, now: number): Floor => {
  if (f.phase._tag === "Speaking" && now >= f.phase.safetyUntil) {
    return { ...f, phase: { _tag: "Open" }, lastEndedAt: Option.some(now) }
  }
  return f
}

export const composingExpired = (f: Floor, now: number): Option.Option<SpeechId> =>
  f.phase._tag === "Composing" && now >= f.phase.until ? Option.some(f.phase.id) : Option.none()

export const currentSpeech = (f: Floor): Option.Option<SpeechId> =>
  f.phase._tag === "Open" ? Option.none() : Option.some(f.phase.id)
