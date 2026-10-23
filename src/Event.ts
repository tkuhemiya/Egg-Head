/**
 * Event: what one Bridge input did, for the dashboard, the page and the Judge.
 * `speech` and `moves` are the source of truth; `said` / `saidKind` / `agent` / `request` /
 * `claim` / `note` are filled as a projection so existing tests and demo JS keep working.
 */
import { Option, Schema } from "effect"
import * as C from "./Conversation.ts"
import { SaidKind } from "./Expect.ts"
import * as G from "./Gate.ts"
import { Basis, Certainty, ClaimId, JobId, RequestId, SpeechId } from "./Ids.ts"
import { Route } from "./Router.ts"

export const Verdict = Schema.Literals(["supports", "contradicts", "inconclusive"])
export type Verdict = typeof Verdict.Type
export const JobKind = Schema.Literals(["confirm", "recheck", "answer"])
export type JobKind = typeof JobKind.Type
export const Via = Schema.Literals(["investigator", "direct"])
export type Via = typeof Via.Type

export const Speech = Schema.Struct({
  id: SpeechId,
  kind: SaidKind,
  text: Schema.String,
  certainty: Certainty,
  basis: Schema.OptionFromNullOr(Basis),
  toward: Schema.String,
  about: Schema.OptionFromNullOr(Schema.String)
})
export type Speech = typeof Speech.Type

export const ClosedWhy = Schema.Literals(["spoken", "corrected", "overruled", "parked", "undetermined", "unverifiable"])
export type ClosedWhy = typeof ClosedWhy.Type
export const JobEnd = Schema.Literals(["found", "unknown", "failed", "timedOut", "cancelled"])
export type JobEnd = typeof JobEnd.Type

export const Move = Schema.Union([
  Schema.TaggedStruct("Opened", { claim: ClaimId, resource: Schema.String, check: Schema.String, turn: Schema.Int }),
  Schema.TaggedStruct("Dispatched", {
    job: JobId,
    kind: JobKind,
    via: Via,
    claim: Schema.OptionFromNullOr(ClaimId),
    request: Schema.OptionFromNullOr(RequestId),
    detail: Schema.String
  }),
  Schema.TaggedStruct("Reported", { job: JobId, kind: JobKind, end: JobEnd, detail: Schema.String, by: Schema.String, ms: Schema.Number }),
  Schema.TaggedStruct("Closed", { claim: ClaimId, resource: Schema.String, why: ClosedWhy, detail: Schema.String }),
  Schema.TaggedStruct("Requested", {
    request: RequestId,
    kind: Schema.Literals(["addressed", "open"]),
    speaker: Schema.String,
    phase: Schema.Literals(["listening", "working", "ready", "answered", "dropped"]),
    detail: Schema.String
  }),
  Schema.TaggedStruct("Held", { why: Schema.Literals(["speaking", "composing", "analysing", "oneLinePerGap"]) }),
  Schema.TaggedStruct("Note", { text: Schema.String })
])
export type Move = typeof Move.Type

export const AgentNote = Schema.Struct({
  task: Schema.Int,
  job: Schema.Literals(["confirm", "answer"]),
  action: Schema.Literals(["dispatched", "reported", "failed", "skipped"]),
  detail: Schema.String,
  by: Schema.optionalKey(Schema.String),
  ms: Schema.optionalKey(Schema.Number)
})
export type AgentNote = typeof AgentNote.Type

export const Event = Schema.Struct({
  seq: Schema.optionalKey(Schema.Int),
  turn: Schema.Int,
  speaker: Schema.String,
  text: Schema.String,
  deciderMs: Schema.Number,
  route: Schema.OptionFromNullOr(Route),
  verdict: Schema.OptionFromNullOr(Verdict),
  checkEvidence: Schema.OptionFromNullOr(Schema.String),
  gate: Schema.OptionFromNullOr(G.GateDecision),
  gateScores: Schema.Record(Schema.String, Schema.Number),
  said: Schema.OptionFromNullOr(Schema.String),
  escalations: Schema.Int,
  saidKind: Schema.optionalKey(Schema.Literals(["flag", "ack", "answer", "barge", "retract"])),
  agent: Schema.optionalKey(AgentNote),
  request: Schema.optionalKey(C.Request),
  note: Schema.optionalKey(Schema.String),
  claim: Schema.optionalKey(Schema.Int),
  speech: Schema.optionalKey(Schema.OptionFromNullOr(Speech)),
  moves: Schema.optionalKey(Schema.Array(Move))
})
export type Event = typeof Event.Type

export const blankEvent = (turn: number, speaker: string, text: string): Event => ({
  turn,
  speaker,
  text,
  deciderMs: 0,
  route: Option.none(),
  verdict: Option.none(),
  checkEvidence: Option.none(),
  gate: Option.none(),
  gateScores: {},
  said: Option.none(),
  escalations: 0,
  speech: Option.none(),
  moves: []
})

const publicKind = (kind: SaidKind): NonNullable<Event["saidKind"]> =>
  kind === "take" ? "ack" : kind === "retract" ? "retract" : kind

/** Fill the dashboard/test projection from speech and moves. */
export const project = (ev: Event): Event => {
  const speech = ev.speech !== undefined && Option.isSome(ev.speech) ? ev.speech.value : undefined
  const moves = ev.moves ?? []
  const dispatched = [...moves].reverse().find((m) => m._tag === "Dispatched")
  const reported = [...moves].reverse().find((m) => m._tag === "Reported")
  const requested = [...moves].reverse().find((m) => m._tag === "Requested")
  const opened = [...moves].reverse().find((m) => m._tag === "Opened")
  const closed = [...moves].reverse().find((m) => m._tag === "Closed")
  const note = [...moves].filter((m) => m._tag === "Note").map((m) => m.text).join(" ")
  const agent: AgentNote | undefined = dispatched
    ? {
      task: Number(String(dispatched.job).split("/")[1] ?? 0),
      job: dispatched.kind === "answer" ? "answer" : "confirm",
      action: "dispatched",
      detail: dispatched.detail
    }
    : reported
    ? {
      task: Number(String(reported.job).split("/")[1] ?? 0),
      job: reported.kind === "answer" ? "answer" : "confirm",
      action: reported.end === "failed" || reported.end === "timedOut" ? "failed" : "reported",
      detail: reported.detail,
      ...(reported.by ? { by: reported.by } : {}),
      ms: reported.ms
    }
    : undefined
  const claimTurn = opened ? opened.turn : closed ? Number(String(closed.claim).split(":")[0]) : ev.claim
  return {
    ...ev,
    said: speech ? Option.some(speech.text) : ev.said,
    ...(speech ? { saidKind: publicKind(speech.kind) } : {}),
    ...(agent ? { agent } : {}),
    ...(requested && ev.request ? { request: ev.request } : {}),
    ...(note && ev.note === undefined ? { note } : {}),
    ...(claimTurn !== undefined ? { claim: claimTurn } : {})
  }
}
