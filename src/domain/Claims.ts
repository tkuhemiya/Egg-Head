/**
 * Claim lifecycle. Single writer of State.claims.
 */
import { Option } from "effect"
import { compare } from "./Compare.ts"
import { factOf } from "./Conversation.ts"
import type { Move } from "./Event.ts"
import { Basis, certaintyOf, ClaimId, claimId, type Voice } from "./Ids.ts"
import * as Jobs from "./Jobs.ts"
import type { Outcome, Report } from "./Jobs.ts"
import type { Verdict } from "./Judgments.ts"
import type { LedgerItem } from "./Ledger.ts"
import type { Command, Ctx, State } from "./State.ts"

export const CLAIM_TAGS = ["Fresh", "Checking", "Standing", "Closed"] as const

export type Closure =
  | { readonly _tag: "Spoken"; readonly as: "flag" | "barge"; readonly certainty: "firm" | "tentative" }
  | { readonly _tag: "Corrected"; readonly by: "ledger" | "keyword" | "decider" }
  | { readonly _tag: "Overruled"; readonly fact: string }
  | { readonly _tag: "Parked" }
  | { readonly _tag: "Undetermined"; readonly why: string }
  | { readonly _tag: "Unverifiable"; readonly why: string }

export type Phase =
  | { readonly _tag: "Fresh" }
  | { readonly _tag: "Checking"; readonly job: string }
  | { readonly _tag: "Standing"; readonly basis: Basis; readonly voice: "firm" | "couldNotConfirm"; readonly fact: string }
  | { readonly _tag: "Closed"; readonly why: Closure }

export interface Claim {
  readonly id: ClaimId
  readonly speaker: string
  readonly claim: string
  readonly check: string
  readonly resource: string
  readonly asserted: Option.Option<string>
  readonly status: LedgerItem["status"]
  readonly evidence: string
  readonly turn: number
  readonly phase: Phase
  readonly toldTentatively: boolean
  readonly retractionOwed: boolean
}

export type Claims = ReadonlyArray<Claim>
type Tag<T extends Phase["_tag"]> = Claim & { readonly phase: Extract<Phase, { _tag: T }> }
export type Standing = Tag<"Standing">
export type Bargeable = Tag<"Fresh"> | Tag<"Checking"> | Tag<"Standing">

export const isOpen = (c: Claim): boolean => c.phase._tag !== "Closed"
export const standing = (cs: Claims): ReadonlyArray<Standing> =>
  cs.filter((c): c is Standing => c.phase._tag === "Standing")

export const bargeable = (c: Claim): c is Bargeable => {
  if (c.phase._tag === "Closed") return false
  if (c.toldTentatively && !(c.phase._tag === "Standing" && c.phase.basis === "confirmed")) return false
  return true
}

export const bargeVoice = (c: Bargeable): Voice =>
  c.phase._tag === "Standing" && c.phase.basis === "confirmed" ? "firm" : "doubleChecking"

export const factOfClaim = (c: Claim): string =>
  c.phase._tag === "Standing" ? c.phase.fact : factOf(c)

export interface Delta {
  readonly claims: Claims
  readonly jobs: Jobs.Jobs
  readonly moves: ReadonlyArray<Move>
  readonly commands: ReadonlyArray<Command>
}

const none: Pick<Delta, "moves" | "commands"> = { moves: [], commands: [] }

export const observe = (
  s: State,
  draft: Omit<Claim, "phase" | "toldTentatively" | "retractionOwed" | "id">,
  ctx: Ctx
): Delta => {
  if (s.claims.some((c) => isOpen(c) && c.check === draft.check && c.resource === draft.resource)) {
    return { claims: s.claims, jobs: s.jobs, ...none }
  }
  const id = claimId(draft.turn, draft.check, draft.resource)
  const fact = factOf(draft)
  const phase: Phase = ctx.policy.secondLook
    ? { _tag: "Fresh" }
    : { _tag: "Standing", basis: "fastCheck", voice: "firm", fact }
  const claim: Claim = { ...draft, id, phase, toldTentatively: false, retractionOwed: false }
  return {
    claims: [...s.claims, claim],
    jobs: s.jobs,
    moves: [{ _tag: "Opened", claim: id, resource: draft.resource, check: draft.check, turn: draft.turn }],
    commands: []
  }
}

export const judge = (s: State, verdicts: ReadonlyArray<Verdict>, ctx: Ctx): Delta => {
  let claims = s.claims
  let jobs = s.jobs
  const moves: Array<Move> = []
  const commands: Array<Command> = []
  const byItem = new Map(verdicts.map((v) => [String(v.item), v]))
  claims = claims.map((c) => {
    if (!isOpen(c)) return c
    const corr = verdicts.find((v) => v.query === "Corrects" && v.item === c.id)
    if (corr && corr.p >= ctx.tuning.gate.selfRepaired) {
      const by = corr.via === "ledger" || corr.via === "keyword" || corr.via === "decider" ? corr.via : "decider"
      if (c.phase._tag === "Checking") {
        const id = c.phase.job as Claim["phase"] extends { job: infer J } ? J : never
        void id
        const jobId = c.phase.job as import("./Ids.ts").JobId
        const fin = Jobs.finish(jobs, jobId, { _tag: "Cancelled" }, ctx.now)
        if (Option.isSome(fin)) jobs = fin.value[0]
        commands.push({ _tag: "CancelJob", id: jobId })
      }
      moves.push({ _tag: "Closed", claim: c.id, resource: c.resource, why: "corrected", detail: `corrected by the call (${by})` })
      return { ...c, phase: { _tag: "Closed", why: { _tag: "Corrected", by } } }
    }
    const park = byItem.get(String(c.id)) && verdicts.find((v) => v.query === "Parks" && v.item === c.id)
    if (park && park.p >= ctx.tuning.parked) {
      if (c.phase._tag === "Checking") {
        const jobId = c.phase.job as import("./Ids.ts").JobId
        const fin = Jobs.finish(jobs, jobId, { _tag: "Cancelled" }, ctx.now)
        if (Option.isSome(fin)) jobs = fin.value[0]
        commands.push({ _tag: "CancelJob", id: jobId })
      }
      moves.push({ _tag: "Closed", claim: c.id, resource: c.resource, why: "parked", detail: `parked ${c.resource}` })
      return { ...c, phase: { _tag: "Closed", why: { _tag: "Parked" } } }
    }
    return c
  })
  return { claims, jobs, moves, commands }
}

const startLook = (s: State, c: Claim, kind: "confirm" | "recheck", via: Jobs.Via, ctx: Ctx): Delta => {
  const deadline = kind === "recheck" ? ctx.tuning.jobs.recheckS : ctx.tuning.jobs.confirmS
  const [jobs, job] = Jobs.start(
    s.jobs,
    { kind, via, subject: { _tag: "Claim", id: c.id }, attempt: kind === "recheck" ? 2 : 1 },
    ctx.now,
    deadline
  )
  const claims = s.claims.map((x) => x.id === c.id ? { ...x, phase: { _tag: "Checking" as const, job: job.id } } : x)
  const payload: Command = { _tag: "StartJob", job, payload: { kind, claim: { ...c, phase: { _tag: "Checking", job: job.id } } } }
  return {
    claims,
    jobs,
    moves: [{
      _tag: "Dispatched",
      job: job.id,
      kind,
      via,
      claim: Option.some(c.id),
      request: Option.none(),
      detail: `${c.speaker}: "${c.claim}" (fast check: ${c.check} on ${c.resource} is ${c.status})`
    }],
    commands: [payload]
  }
}

export const secondLook = (s: State, ctx: Ctx): Delta => {
  if (!ctx.policy.secondLook) return { claims: s.claims, jobs: s.jobs, ...none }
  let claims = s.claims
  let jobs = s.jobs
  const moves: Array<Move> = []
  const commands: Array<Command> = []
  const turn = s.turns.length - 1
  for (const c of s.claims) {
    if (c.phase._tag !== "Fresh" || c.turn >= turn) continue
    const d = startLook({ ...s, claims, jobs }, c, "confirm", ctx.policy.secondLook ? "investigator" : "direct", ctx)
    claims = d.claims
    jobs = d.jobs
    moves.push(...d.moves)
    commands.push(...d.commands)
  }
  return { claims, jobs, moves, commands }
}

const stillWrong = (c: Claim, status: string): boolean => compare(Option.getOrUndefined(c.asserted), status) === "contradicts"

export const jobFinished = (s: State, jobId: string, outcome: Outcome, ctx: Ctx): Delta => {
  const c = s.claims.find((x) => x.phase._tag === "Checking" && x.phase.job === jobId)
  if (c === undefined) return { claims: s.claims, jobs: s.jobs, ...none }
  const job = Jobs.get(s.jobs, jobId as import("./Ids.ts").JobId)
  const viaNote = (r: Report) => r._tag === "Checked" || r._tag === "Unknown" || r._tag === "Answered" ? r.by : "direct"
  if (outcome._tag === "Cancelled") {
    return { claims: s.claims, jobs: s.jobs, ...none }
  }
  if (outcome._tag === "Reported" && outcome.report._tag === "Unknown") {
    const why = outcome.report.why
    const retractionOwed = c.toldTentatively
    const closed: Claim = {
      ...c,
      phase: { _tag: "Closed", why: { _tag: "Undetermined", why } },
      retractionOwed
    }
    return {
      claims: s.claims.map((x) => x.id === c.id ? closed : x),
      jobs: s.jobs,
      moves: [{ _tag: "Closed", claim: c.id, resource: c.resource, why: "undetermined", detail: why }],
      commands: []
    }
  }
  if (outcome._tag === "Reported" && outcome.report._tag === "Checked") {
    const r = outcome.report
    const wrong = stillWrong(c, r.status)
    if (!wrong) {
      const closed: Claim = {
        ...c,
        phase: { _tag: "Closed", why: { _tag: "Overruled", fact: r.fact } },
        retractionOwed: c.toldTentatively
      }
      return {
        claims: s.claims.map((x) => x.id === c.id ? closed : x),
        jobs: s.jobs,
        moves: [{ _tag: "Closed", claim: c.id, resource: c.resource, why: "overruled", detail: `overruled the fast check: ${r.status} (${r.fact})` }],
        commands: []
      }
    }
    if (c.toldTentatively) {
      const closed: Claim = { ...c, phase: { _tag: "Closed", why: { _tag: "Spoken", as: "barge", certainty: "tentative" } } }
      return {
        claims: s.claims.map((x) => x.id === c.id ? closed : x),
        jobs: s.jobs,
        moves: [{ _tag: "Closed", claim: c.id, resource: c.resource, why: "spoken", detail: `confirmed: ${r.fact}` }],
        commands: []
      }
    }
    const basis: Basis = job?.kind === "confirm" && job.via === "investigator" ? "confirmed" : "fastCheck"
    const voice = basis === "confirmed" ? "firm" as const : "couldNotConfirm" as const
    const standingC: Claim = { ...c, phase: { _tag: "Standing", basis, voice, fact: r.fact } }
    return {
      claims: s.claims.map((x) => x.id === c.id ? standingC : x),
      jobs: s.jobs,
      moves: [],
      commands: []
    }
  }
  // Failed / TimedOut
  if (job && job.attempt === 1) {
    return startLook(s, c, "recheck", "direct", ctx)
  }
  if (c.toldTentatively) {
    const closed: Claim = {
      ...c,
      phase: { _tag: "Closed", why: { _tag: "Unverifiable", why: "second look failed" } },
      retractionOwed: true
    }
    return {
      claims: s.claims.map((x) => x.id === c.id ? closed : x),
      jobs: s.jobs,
      moves: [{ _tag: "Closed", claim: c.id, resource: c.resource, why: "unverifiable", detail: "second look failed" }],
      commands: []
    }
  }
  // recheck failed: still flag from the fast check, tentatively
  const standingC: Claim = {
    ...c,
    phase: { _tag: "Standing", basis: "fastCheck", voice: "couldNotConfirm", fact: factOf(c) }
  }
  return { claims: s.claims.map((x) => x.id === c.id ? standingC : x), jobs: s.jobs, ...none }
  void viaNote
}

export const spoken = (
  s: State,
  id: ClaimId,
  how: { kind: "flag" | "barge"; voice: Voice; speech: import("./Ids.ts").SpeechId },
  ctx: Ctx
): Delta => {
  const c = s.claims.find((x) => x.id === id)
  if (c === undefined || !isOpen(c)) return { claims: s.claims, jobs: s.jobs, ...none }
  if (how.kind === "flag") {
    const closed: Claim = {
      ...c,
      phase: { _tag: "Closed", why: { _tag: "Spoken", as: "flag", certainty: certaintyOf(how.voice) } }
    }
    return {
      claims: s.claims.map((x) => x.id === id ? closed : x),
      jobs: s.jobs,
      moves: [{ _tag: "Closed", claim: id, resource: c.resource, why: "spoken", detail: "flagged" }],
      commands: []
    }
  }
  // tentative barge: mark told, start confirm if none running
  let jobs = s.jobs
  const moves: Array<Move> = []
  const commands: Array<Command> = []
  let claims = s.claims.map((x) => x.id === id ? { ...x, toldTentatively: true } : x)
  const cur = claims.find((x) => x.id === id)!
  if (cur.phase._tag !== "Checking" && ctx.policy.secondLook && how.voice !== "firm") {
    const d = startLook({ ...s, claims, jobs }, cur, "confirm", "investigator", ctx)
    claims = d.claims.map((x) => x.id === id ? { ...x, toldTentatively: true } : x)
    jobs = d.jobs
    moves.push(...d.moves)
    commands.push(...d.commands)
  }
  if (how.voice === "firm") {
    const closed: Claim = {
      ...cur,
      toldTentatively: true,
      phase: { _tag: "Closed", why: { _tag: "Spoken", as: "barge", certainty: "firm" } }
    }
    claims = claims.map((x) => x.id === id ? closed : x)
    moves.push({ _tag: "Closed", claim: id, resource: c.resource, why: "spoken", detail: "barged" })
  }
  return { claims, jobs, moves, commands }
}

export const retracted = (cs: Claims, id: ClaimId): Claims =>
  cs.map((c) => c.id === id ? { ...c, retractionOwed: false } : c)

export const toLedgerItem = (c: Claim, agentMode: boolean): LedgerItem => {
  const raised = c.phase._tag === "Closed" || c.toldTentatively
  const fact = c.phase._tag === "Standing" ? c.phase.fact : c.phase._tag === "Closed" && c.phase.why._tag === "Overruled" ? c.phase.why.fact : undefined
  const agent =
    !agentMode ? undefined
    : c.phase._tag === "Fresh" ? "pending" as const
    : c.phase._tag === "Checking" ? "checking" as const
    : c.phase._tag === "Standing" ? "confirmed" as const
    : c.phase.why._tag === "Overruled" ? "overruled" as const
    : c.phase.why._tag === "Corrected" || c.phase.why._tag === "Parked" ? "skipped" as const
    : "confirmed" as const
  return {
    speaker: c.speaker,
    claim: c.claim,
    check: c.check,
    resource: c.resource,
    status: c.status,
    evidence: c.evidence,
    turn: c.turn,
    raised,
    ...(agent ? { agent } : {}),
    ...(fact ? { fact } : {}),
    ...(Option.isSome(c.asserted) ? { asserted: c.asserted.value } : {})
  }
}
