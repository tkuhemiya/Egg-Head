/**
 * Request lifecycle. Entering Working is the ack.
 */
import { Option } from "effect"
import * as C from "./Conversation.ts"
import type { Move } from "./Event.ts"
import { requestId, type RequestId } from "./Ids.ts"
import * as Jobs from "./Jobs.ts"
import type { Outcome } from "./Jobs.ts"
import type { Verdict } from "./Judgments.ts"
import type { Command, Ctx, State } from "./State.ts"

export const REQUEST_TAGS = ["Listening", "Working", "Ready", "Closed"] as const

export type Answer =
  | { readonly _tag: "Found"; readonly text: string }
  | { readonly _tag: "Unable"; readonly reason: "unknown" | "failed" | "noResource" }

export type Phase =
  | { readonly _tag: "Listening" }
  | { readonly _tag: "Working"; readonly job: import("./Ids.ts").JobId }
  | { readonly _tag: "Ready"; readonly answer: Answer }
  | { readonly _tag: "Closed"; readonly why: "answered" | "dropped"; readonly note: string }

export interface Request {
  readonly id: RequestId
  readonly kind: "addressed" | "open"
  readonly speaker: string
  readonly text: string
  readonly turn: number
  readonly phase: Phase
  readonly note: string
}
export type Requests = ReadonlyArray<Request>

export interface Delta {
  readonly requests: Requests
  readonly jobs: Jobs.Jobs
  readonly nextRequest: number
  readonly moves: ReadonlyArray<Move>
  readonly commands: ReadonlyArray<Command>
}

const none = (s: State): Delta => ({ requests: s.requests, jobs: s.jobs, nextRequest: s.nextRequest, moves: [], commands: [] })

export const live = (rs: Requests): Requests => rs.filter((r) => r.phase._tag !== "Closed")

export const toPublic = (r: Request): C.Request => ({
  id: r.id,
  kind: r.kind,
  speaker: r.speaker,
  text: r.text,
  turn: r.turn,
  state: r.phase._tag === "Listening" ? "listening"
    : r.phase._tag === "Working" ? "checking"
    : r.phase._tag === "Ready" ? "ready"
    : r.phase.why,
  answer: r.phase._tag === "Ready" && r.phase.answer._tag === "Found" ? Option.some(r.phase.answer.text) : Option.none(),
  note: r.note
})

export const intake = (
  s: State,
  line: { readonly speaker: string; readonly text: string; readonly turn: number },
  signals: Option.Option<{ addressedP: Option.Option<number>; asksP: Option.Option<number> }>,
  verdicts: ReadonlyArray<Verdict>,
  ctx: Ctx,
  routedCheck: boolean
): Delta => {
  if (!ctx.policy.conversation) return none(s)
  let requests = s.requests
  const moves: Array<Move> = []
  const addressedP = Option.flatMap(signals, (x) => x.addressedP)
  const asksP = Option.flatMap(signals, (x) => x.asksP)
  const listening = requests.find((r) => r.phase._tag === "Listening")
  if (listening?.kind === "addressed" && listening.speaker === line.speaker) {
    const req: Request = { ...listening, text: `${listening.text} ${line.text}`, note: "still asking" }
    requests = requests.map((r) => r.id === req.id ? req : r)
    moves.push({ _tag: "Requested", request: req.id, kind: req.kind, speaker: req.speaker, phase: "listening", detail: req.note })
    return { requests, jobs: s.jobs, nextRequest: s.nextRequest, moves, commands: [] }
  }
  if (C.namesEggHead(line.text) && Option.getOrElse(addressedP, () => 0) >= ctx.tuning.addressed) {
    const req: Request = {
      id: requestId(s.nextRequest),
      kind: "addressed",
      speaker: line.speaker,
      text: line.text,
      turn: line.turn,
      phase: { _tag: "Listening" },
      note: `asked Egg Head (Decider ${Option.getOrElse(addressedP, () => 0).toFixed(2)})`
    }
    requests = [...requests.map(dropOpen(line.speaker)), req]
    moves.push({ _tag: "Requested", request: req.id, kind: "addressed", speaker: line.speaker, phase: "listening", detail: req.note })
    return { requests, jobs: s.jobs, nextRequest: s.nextRequest + 1, moves, commands: [] }
  }
  if (C.isQuestion(line.text) && Option.getOrElse(asksP, () => 0) >= ctx.tuning.asks && !routedCheck) {
    const req: Request = {
      id: requestId(s.nextRequest),
      kind: "open",
      speaker: line.speaker,
      text: line.text,
      turn: line.turn,
      phase: { _tag: "Listening" },
      note: `question to the call (Decider ${Option.getOrElse(asksP, () => 0).toFixed(2)}); waiting to see if anyone answers`
    }
    requests = [...requests.map(dropOpen(line.speaker)), req]
    moves.push({ _tag: "Requested", request: req.id, kind: "open", speaker: line.speaker, phase: "listening", detail: req.note })
    return { requests, jobs: s.jobs, nextRequest: s.nextRequest + 1, moves, commands: [] }
  }
  const answered = verdicts.find((v) => v.query === "Answers" && v.p >= 0.5)
  const dropped = requests.find((r) => r.kind === "open" && r.phase._tag === "Listening" && r.speaker !== line.speaker)
  if (dropped && (answered || true)) {
    // today's rule: a different speaker spoke next
    const req: Request = { ...dropped, phase: { _tag: "Closed", why: "dropped", note: `${line.speaker} answered; Egg Head stays out` }, note: `${line.speaker} answered; Egg Head stays out` }
    requests = requests.map((r) => r.id === req.id ? req : r)
    moves.push({ _tag: "Requested", request: req.id, kind: "open", speaker: dropped.speaker, phase: "dropped", detail: req.note })
    return { requests, jobs: s.jobs, nextRequest: s.nextRequest, moves, commands: [] }
  }
  return { requests, jobs: s.jobs, nextRequest: s.nextRequest, moves, commands: [] }
}

const dropOpen = (speaker: string) => (r: Request): Request =>
  r.kind === "open" && r.phase._tag === "Listening"
    ? { ...r, phase: { _tag: "Closed", why: "dropped", note: `${speaker} moved on` }, note: `${speaker} moved on` }
    : r

export const worked = (s: State, id: RequestId, ctx: Ctx): Delta => {
  const req = s.requests.find((r) => r.id === id && r.phase._tag === "Listening")
  if (req === undefined) return none(s)
  const via: Jobs.Via = ctx.policy.conversation ? "investigator" : "direct"
  const [jobs, job] = Jobs.start(
    s.jobs,
    { kind: "answer", via, subject: { _tag: "Request", id }, attempt: 1 },
    ctx.now,
    ctx.tuning.jobs.answerS
  )
  const next: Request = { ...req, phase: { _tag: "Working", job: job.id }, note: `agent task ${Jobs.get(jobs, job.id)?.id}` }
  const requests = s.requests.map((r) => r.id === id ? { ...next, note: `agent task ${String(job.id).split("/")[1]}` } : r)
  return {
    requests,
    jobs,
    nextRequest: s.nextRequest,
    moves: [{
      _tag: "Dispatched",
      job: job.id,
      kind: "answer",
      via,
      claim: Option.none(),
      request: Option.some(id),
      detail: req.text
    }],
    commands: [{
      _tag: "StartJob",
      job,
      payload: { kind: "answer", question: { speaker: req.speaker, text: req.text, addressed: req.kind === "addressed" } }
    }]
  }
}

export const jobFinished = (s: State, jobId: import("./Ids.ts").JobId, o: Outcome, ctx: Ctx): Delta => {
  const req = s.requests.find((r) => r.phase._tag === "Working" && r.phase.job === jobId)
  if (req === undefined) return none(s)
  const job = Jobs.get(s.jobs, jobId)
  if (o._tag === "Reported" && o.report._tag === "Answered") {
    const next: Request = { ...req, phase: { _tag: "Ready", answer: { _tag: "Found", text: o.report.text } }, note: "answer ready; waiting for a gap" }
    return { requests: s.requests.map((r) => r.id === req.id ? next : r), jobs: s.jobs, nextRequest: s.nextRequest, moves: [], commands: [] }
  }
  if (o._tag === "Reported" && o.report._tag === "Unknown") {
    const next: Request = { ...req, phase: { _tag: "Ready", answer: { _tag: "Unable", reason: "unknown" } }, note: o.report.why }
    return { requests: s.requests.map((r) => r.id === req.id ? next : r), jobs: s.jobs, nextRequest: s.nextRequest, moves: [], commands: [] }
  }
  if ((o._tag === "Failed" || o._tag === "TimedOut") && job && job.attempt === 1) {
    const [jobs, fallback] = Jobs.start(
      s.jobs,
      { kind: "answer", via: "direct", subject: { _tag: "Request", id: req.id }, attempt: 2 },
      ctx.now,
      ctx.tuning.jobs.recheckS
    )
    const next: Request = { ...req, phase: { _tag: "Working", job: fallback.id }, note: "direct fallback" }
    return {
      requests: s.requests.map((r) => r.id === req.id ? next : r),
      jobs,
      nextRequest: s.nextRequest,
      moves: [{
        _tag: "Dispatched",
        job: fallback.id,
        kind: "answer",
        via: "direct",
        claim: Option.none(),
        request: Option.some(req.id),
        detail: req.text
      }],
      commands: [{
        _tag: "StartJob",
        job: fallback,
        payload: { kind: "answer", question: { speaker: req.speaker, text: req.text, addressed: req.kind === "addressed" } }
      }]
    }
  }
  const next: Request = { ...req, phase: { _tag: "Ready", answer: { _tag: "Unable", reason: "failed" } }, note: "could not find that out" }
  return { requests: s.requests.map((r) => r.id === req.id ? next : r), jobs: s.jobs, nextRequest: s.nextRequest, moves: [], commands: [] }
}

export const answered = (rs: Requests, id: RequestId): Requests =>
  rs.map((r) => r.id === id ? { ...r, phase: { _tag: "Closed", why: "answered" as const, note: "answered" }, note: "answered" } : r)
