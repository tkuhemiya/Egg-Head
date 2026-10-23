/**
 * The reducer. Pure, total, deterministic.
 */
import { Option } from "effect"
import * as Agenda from "./Agenda.ts"
import * as Claims from "./Claims.ts"
import * as C from "./Conversation.ts"
import { blankEvent, project, type Event, type Move, type Speech } from "./Event.ts"
import * as Floor from "./Floor.ts"
import { certaintyOf, type ClaimId, type SpeechId } from "./Ids.ts"
import * as Jobs from "./Jobs.ts"
import * as Requests from "./Requests.ts"
import { aliasHits } from "./Router.ts"
import { templateLine } from "./Speaker.ts"
import type { Command, Ctx, Input, LineEvidence, State, Transition } from "./State.ts"

const merge = (s: State, d: { claims?: Claims.Claims; requests?: Requests.Requests; jobs?: Jobs.Jobs; nextRequest?: number }, moves: ReadonlyArray<Move>, commands: ReadonlyArray<Command>) => ({
  state: {
    ...s,
    ...(d.claims ? { claims: d.claims } : {}),
    ...(d.requests ? { requests: d.requests } : {}),
    ...(d.jobs ? { jobs: d.jobs } : {}),
    ...(d.nextRequest !== undefined ? { nextRequest: d.nextRequest } : {})
  } satisfies State,
  moves,
  commands
})

const commitEvent = (s: State, ev: Event, commands: ReadonlyArray<Command>, hold: boolean): Transition => {
  const event = project({ ...ev, seq: s.nextSeq, moves: ev.moves ?? [] })
  if (hold) return { state: s, event: Option.some(event), commands }
  return {
    state: { ...s, events: [...s.events, event], nextSeq: s.nextSeq + 1 },
    event: Option.some(event),
    commands
  }
}

const sweep = (s: State, ctx: Ctx): { state: State; moves: Array<Move>; commands: Array<Command> } => {
  let state = { ...s, floor: Floor.expire(s.floor, ctx.now) }
  const moves: Array<Move> = []
  const commands: Array<Command> = []
  for (const job of Jobs.expired(state.jobs, ctx.now)) {
    const fin = Jobs.finish(state.jobs, job.id, { _tag: "TimedOut" }, ctx.now)
    if (Option.isNone(fin)) continue
    state = { ...state, jobs: fin.value[0] }
    const dClaim = Claims.jobFinished(state, job.id, { _tag: "TimedOut" }, ctx)
    const dReq = Requests.jobFinished(state, job.id, { _tag: "TimedOut" }, ctx)
    state = { ...state, claims: dClaim.claims, jobs: dClaim.jobs }
    state = { ...state, requests: dReq.requests, jobs: dReq.jobs, nextRequest: dReq.nextRequest }
    moves.push(...dClaim.moves, ...dReq.moves)
    commands.push(...dClaim.commands, ...dReq.commands)
  }
  return { state, moves, commands }
}

const applyPick = (s: State, pick: Agenda.Pick, silenceS: number, ctx: Ctx, base: Event): { state: State; event: Event; commands: Array<Command> } => {
  const notes = pick.notes.filter((n) => !s.notes.includes(n))
  let state: State = { ...s, notes: [...s.notes, ...notes.map((n) => n)] }
  // keep a stable key in notes: the Agenda already used `${id}:${why}`
  for (const n of pick.notes) {
    const listening = s.requests.find((r) => r.phase._tag === "Listening")
    if (listening) state = { ...state, notes: state.notes.includes(`${listening.id}:${n}`) ? state.notes : [...state.notes, `${listening.id}:${n.includes("trails") ? "trails off mid-sentence" : n}`] }
  }
  const moves: Array<Move> = notes.map((text) => ({ _tag: "Note" as const, text }))
  const commands: Array<Command> = []
  let event = {
    ...base,
    gate: pick.gate,
    ...(notes[0] ? { note: notes[0] } : base.note ? { note: base.note } : {}),
    ...(base.request ? { request: base.request } : {})
  } as Event
  if (Option.isSome(pick.held)) {
    moves.push({ _tag: "Held", why: pick.held.value })
    event = { ...event, moves: [...(event.moves ?? []), ...moves] }
    return { state, event, commands }
  }
  if (Option.isNone(pick.intent)) {
    event = { ...event, moves: [...(event.moves ?? []), ...moves] }
    return { state, event, commands }
  }
  const intent = pick.intent.value
  const unprompted = intent._tag === "Flag" || intent._tag === "Retract"
  if (intent._tag === "Ack" || intent._tag === "Take") {
    const d = Requests.worked(state, intent.request.id, ctx)
    state = { ...state, requests: d.requests, jobs: d.jobs, nextRequest: d.nextRequest }
    moves.push(...d.moves)
    commands.push(...d.commands)
    const req = state.requests.find((r) => r.id === intent.request.id)!
    const kind = intent._tag === "Take" ? "take" as const : "ack" as const
    const text = intent._tag === "Take" ? C.OPEN_ACK : C.ackLine(intent.request.speaker)
    const speech: Speech = {
      id: Floor.currentSpeech(state.floor).pipe(Option.getOrElse(() => `${state.epoch}/s${state.floor.seq + 1}` as SpeechId)),
      kind,
      text,
      certainty: "firm",
      basis: Option.none(),
      toward: intent.request.speaker,
      about: Option.fromUndefinedOr(aliasHits(intent.request.text)[0])
    }
    const dispatched = d.moves.find((m) => m._tag === "Dispatched") as Extract<Move, { _tag: "Dispatched" }> | undefined
    event = {
      ...event,
      request: Requests.toPublic(req),
      speech: Option.some(speech),
      saidKind: "ack",
      ...(dispatched
        ? {
          agent: {
            task: Number(String(dispatched.job).split("/")[1]),
            job: "answer" as const,
            action: "dispatched" as const,
            detail: intent.request.text
          }
        }
        : {})
    }
    const draft = project({ ...event, speech: Option.some(speech), moves: [...(event.moves ?? []), ...moves] })
    state = { ...state, floor: Floor.take(state.floor, state.epoch, false, state.turns.length, ctx.now, ctx.tuning, false, draft) }
    const id = Floor.currentSpeech(state.floor)
    event = { ...event, speech: Option.map(id, (sid) => ({ ...speech, id: sid })), moves: [...(event.moves ?? []), ...moves] }
    return { state, event, commands }
  }
  if (intent._tag === "Answer") {
    const req = intent.request
    const text = req.phase._tag === "Ready" && req.phase.answer._tag === "Found"
      ? C.answerLine(req.speaker, req.phase.answer.text)
      : C.unableLine(req.speaker)
    const speech: Speech = {
      id: `${state.epoch}/s0` as SpeechId,
      kind: "answer",
      text,
      certainty: "firm",
      basis: Option.none(),
      toward: req.speaker,
      about: Option.fromUndefinedOr(aliasHits(req.text)[0])
    }
    state = { ...state, requests: Requests.answered(state.requests, req.id) }
    const publicReq = Requests.toPublic(state.requests.find((r) => r.id === req.id)!)
    const draft = project({ ...event, speech: Option.some(speech), request: publicReq, moves })
    state = { ...state, floor: Floor.take(state.floor, state.epoch, false, state.turns.length, ctx.now, ctx.tuning, false, draft) }
    const id = Option.getOrThrow(Floor.currentSpeech(state.floor))
    event = { ...event, speech: Option.some({ ...speech, id }), request: publicReq, saidKind: "answer", moves }
    return { state, event, commands }
  }
  if (intent._tag === "Retract") {
    const fact = Claims.factOfClaim(intent.claim)
    const speech: Speech = {
      id: `${state.epoch}/s0` as SpeechId,
      kind: "retract",
      text: C.retractLine(intent.claim.speaker, fact),
      certainty: "firm",
      basis: Option.none(),
      toward: intent.claim.speaker,
      about: Option.some(intent.claim.resource)
    }
    state = { ...state, claims: Claims.retracted(state.claims, intent.claim.id) }
    const draft = project({ ...event, speech: Option.some(speech), claim: intent.claim.turn, moves })
    state = { ...state, floor: Floor.take(state.floor, state.epoch, false, state.turns.length, ctx.now, ctx.tuning, false, draft) }
    const id = Option.getOrThrow(Floor.currentSpeech(state.floor))
    event = { ...event, speech: Option.some({ ...speech, id }), claim: intent.claim.turn, saidKind: "retract", moves }
    return { state, event, commands }
  }
  // Flag
  const claim = intent.claim
  const voice = claim.phase._tag === "Standing" ? (claim.phase.voice === "couldNotConfirm" ? "couldNotConfirm" as const : "firm" as const) : "firm" as const
  const fact = Claims.factOfClaim(claim)
  const needsWriter = !ctx.policy.secondLook
  const text = needsWriter ? templateLine(Claims.toLedgerItem(claim, false)) : C.flagLine(claim.speaker, fact, voice)
  const speech: Speech = {
    id: `${state.epoch}/s0` as SpeechId,
    kind: "flag",
    text,
    certainty: certaintyOf(voice),
    basis: Option.some(claim.phase._tag === "Standing" ? claim.phase.basis : "fastCheck"),
    toward: claim.speaker,
    about: Option.some(claim.resource)
  }
  const d = Claims.spoken(state, claim.id, { kind: "flag", voice, speech: speech.id }, ctx)
  state = { ...state, claims: d.claims, jobs: d.jobs }
  moves.push(...d.moves)
  commands.push(...d.commands)
  const draft = project({ ...event, speech: Option.some(speech), gate: Option.some(intent.gate), claim: claim.turn, moves })
  state = { ...state, floor: Floor.take(state.floor, state.epoch, true, state.turns.length, ctx.now, ctx.tuning, needsWriter, draft) }
  const id = Option.getOrThrow(Floor.currentSpeech(state.floor))
  event = { ...event, speech: Option.some({ ...speech, id }), gate: Option.some(intent.gate), claim: claim.turn, saidKind: "flag", moves }
  if (needsWriter) {
    commands.push({ _tag: "Compose", id, claim })
  }
  return { state, event, commands }
  void unprompted
  void silenceS
}

const speakTail = (
  s: State,
  silenceS: number,
  ctx: Ctx,
  base: Event,
  alsoGate: ReadonlyArray<Claims.Claim> = []
): Transition => {
  const pick = Agenda.next(s, silenceS, ctx, alsoGate)
  const applied = applyPick(s, pick, silenceS, ctx, base)
  const hold = applied.state.floor.phase._tag === "Composing"
  return commitEvent(applied.state, applied.event, applied.commands, hold)
}

const understood = (s: State, turn: number, silenceS: number, ev: LineEvidence, ctx: Ctx): Transition => {
  let state = s
  const allMoves: Array<Move> = []
  const allCommands: Array<Command> = []
  const j = Claims.judge(state, ev.verdicts, ctx)
  state = merge(state, j, j.moves, j.commands).state
  allMoves.push(...j.moves)
  allCommands.push(...j.commands)
  const line = state.turns[turn] ?? ["", ""] as const
  const intake = Requests.intake(state, { speaker: line[0], text: line[1], turn }, Option.map(ev.signals, (sig) => ({ addressedP: sig.addressedP, asksP: sig.asksP })), ev.verdicts, ctx, ev.route.action === "check")
  state = { ...state, requests: intake.requests, jobs: intake.jobs, nextRequest: intake.nextRequest }
  allMoves.push(...intake.moves)
  allCommands.push(...intake.commands)
  const look = Claims.secondLook(state, ctx)
  state = { ...state, claims: look.claims, jobs: look.jobs }
  allMoves.push(...look.moves)
  allCommands.push(...look.commands)
  if (Option.isSome(ev.check) && ev.check.value.verdict === "contradicts") {
    const c = ev.check.value
    const d = Claims.observe(state, {
      speaker: line[0],
      claim: line[1],
      check: c.check,
      resource: c.resource,
      asserted: c.asserted,
      status: c.status as Claims.Claim["status"],
      evidence: c.evidence,
      turn
    }, ctx)
    state = { ...state, claims: d.claims, jobs: d.jobs }
    allMoves.push(...d.moves)
    allCommands.push(...d.commands)
  }
  const escalated = ev.handedOff || ev.route.action === "escalate"
  if (escalated) state = { ...state, escalations: state.escalations + 1 }
  if (Option.isSome(ev.signals)) {
    state = {
      ...state,
      finishedP: ev.signals.value.finishedP,
      interruptP: 1 - ev.signals.value.finishedP,
      selfRepairedP: ev.signals.value.selfRepairedP
    }
  }
  state = { ...state, analysing: Math.max(0, state.analysing - 1) }
  const scores = Option.match(ev.signals, {
    onNone: () => ({}),
    onSome: (a) => ({
      self_repaired: a.selfRepairedP,
      finished: a.finishedP,
      finished_raw: a.finishedRaw,
      ...(Option.isSome(a.addressedP) ? { addressed: a.addressedP.value } : {}),
      ...(Option.isSome(a.asksP) ? { asks: a.asksP.value } : {})
    })
  })
  const publicReq = [...state.requests].reverse().find((r) => r.turn === turn)
  const opened = allMoves.find((m) => m._tag === "Opened")
  const base: Event = {
    ...blankEvent(turn, line[0], line[1]),
    deciderMs: ev.deciderMs,
    route: Option.some(ev.route),
    verdict: Option.map(ev.check, (c) => c.verdict),
    checkEvidence: Option.map(ev.check, (c) => c.evidence),
    gateScores: Object.keys(scores).length ? scores : {},
    escalations: escalated ? 1 : 0,
    moves: allMoves,
    ...(publicReq ? { request: Requests.toPublic(publicReq) } : {}),
    ...(opened ? { claim: opened.turn } : {}),
    ...(look.moves.some((m) => m._tag === "Dispatched")
      ? {
        agent: {
          task: Number(String((look.moves.find((m) => m._tag === "Dispatched") as Extract<Move, { _tag: "Dispatched" }>).job).split("/")[1]),
          job: "confirm" as const,
          action: "dispatched" as const,
          detail: (look.moves.find((m) => m._tag === "Dispatched") as Extract<Move, { _tag: "Dispatched" }>).detail
        }
      }
      : {}),
    ...(j.moves.some((m) => m._tag === "Closed" && m.why === "corrected")
      ? { note: `${line[0]}'s claim was corrected by the call before any LLM call. Staying quiet.`.replace(line[0], state.claims.find((c) => c.phase._tag === "Closed" && c.phase.why._tag === "Corrected")?.speaker ?? line[0]) }
      : {})
  }
  // fix corrected note with the claim speaker
  const corrected = state.claims.find((c) => j.moves.some((m) => m._tag === "Closed" && m.why === "corrected" && m.claim === c.id))
  const withNote = corrected
    ? { ...base, note: `${corrected.speaker}'s claim was corrected by the call (${corrected.phase._tag === "Closed" && corrected.phase.why._tag === "Corrected" ? corrected.phase.why.by : "keyword"}) before any LLM call. Staying quiet.`, claim: corrected.turn }
    : base
  const closedNow = state.claims.filter((c) =>
    allMoves.some((m) => m._tag === "Closed" && m.claim === c.id && (m.why === "corrected" || m.why === "parked"))
  )
  const tail = speakTail(state, silenceS, ctx, withNote, closedNow)
  return {
    state: tail.state,
    event: tail.event,
    commands: [...allCommands, ...tail.commands]
  }
}

export const reduce = (s0: State, i: Input, ctx: Ctx): Transition => {
  const swept = sweep(s0, ctx)
  let s = swept.state
  const extraMoves = swept.moves
  const extraCommands = swept.commands
  const wrap = (t: Transition): Transition => ({
    state: t.state,
    event: t.event,
    commands: [...extraCommands, ...t.commands]
  })
  switch (i._tag) {
    case "LineBegan":
      return wrap({
        state: { ...s, turns: [...s.turns, [i.speaker, i.text] as const], analysing: s.analysing + 1 },
        event: Option.none(),
        commands: []
      })
    case "LineUnderstood":
      return wrap(understood(s, i.turn, i.silenceS, i.evidence, ctx))
    case "LineFailed": {
      const line = s.turns[i.turn] ?? ["", ""] as const
      s = { ...s, analysing: Math.max(0, s.analysing - 1) }
      const ev = { ...blankEvent(i.turn, line[0], line[1]), moves: [{ _tag: "Note" as const, text: `could not understand this line: ${i.reason}` }], note: `could not understand this line: ${i.reason}` }
      return wrap(commitEvent(s, ev, [], false))
    }
    case "Silence":
      if (s.analysing > 0) {
        return wrap({ state: s, event: Option.none(), commands: [] })
      }
      if (s.events.length === 0) return wrap({ state: s, event: Option.none(), commands: [] })
      {
        const t = speakTail(s, i.silenceS, ctx, blankEvent(s.turns.length - 1, "(silence)", ""))
        const ev = t.event
        const happened = Option.isSome(ev) && (
          Option.isSome(ev.value.said) ||
          Option.isSome(ev.value.gate) ||
          ev.value.note !== undefined ||
          ev.value.request !== undefined ||
          (ev.value.moves ?? []).length > 0 ||
          extraMoves.length > 0
        )
        if (!happened && extraCommands.length === 0) return wrap({ state: t.state, event: Option.none(), commands: t.commands })
        return wrap(t)
      }
    case "PartialHeard": {
      const claim = s.claims.find((c) => c.id === i.claim || c.resource === i.claim)
      if (claim === undefined || !Claims.bargeable(claim) || !ctx.policy.barge || s.analysing > 0) {
        return wrap({ state: s, event: Option.none(), commands: [] })
      }
      const act = i.evidence.actP
      const base = {
        ...blankEvent(s.turns.length, i.speaker, i.text),
        deciderMs: i.evidence.deciderMs,
        gateScores: { directive: act },
        claim: claim.turn
      }
      if (act < ctx.tuning.directive) {
        const ev = { ...base, note: `Mentions ${claim.resource} (open claim) but Decider says it is not an instruction to act (${act.toFixed(2)}).` }
        return wrap(commitEvent(s, ev, [], false))
      }
      const voice = Claims.bargeVoice(claim)
      const fact = Claims.factOfClaim(claim)
      const text = C.bargeLine(i.speaker, fact, voice)
      const speech: Speech = {
        id: `${s.epoch}/s0` as SpeechId,
        kind: "barge",
        text,
        certainty: certaintyOf(voice),
        basis: Option.some(claim.phase._tag === "Standing" ? claim.phase.basis : "fastCheck"),
        toward: i.speaker,
        about: Option.some(claim.resource)
      }
      const d = Claims.spoken(s, claim.id as ClaimId, { kind: "barge", voice, speech: speech.id }, ctx)
      s = { ...s, claims: d.claims, jobs: d.jobs }
      const draft = project({
        ...base,
        speech: Option.some(speech),
        saidKind: "barge",
        note: `${i.speaker} is about to act on ${claim.resource} (Decider ${act.toFixed(2)}), but ${claim.speaker}'s claim about it is wrong. Interrupting is cheaper than waiting.`,
        moves: d.moves
      })
      s = { ...s, floor: Floor.take(s.floor, s.epoch, true, s.turns.length, ctx.now, ctx.tuning, false, draft) }
      const id = Option.getOrThrow(Floor.currentSpeech(s.floor))
      const ev = { ...draft, speech: Option.some({ ...speech, id }) }
      return wrap(commitEvent(s, ev, d.commands, false))
    }
    case "JobDone": {
      const fin = Jobs.finish(s.jobs, i.id, i.outcome, ctx.now)
      if (Option.isNone(fin)) return wrap({ state: s, event: Option.none(), commands: [] })
      s = { ...s, jobs: fin.value[0] }
      const job = fin.value[1]
      const dC = Claims.jobFinished(s, i.id, i.outcome, ctx)
      s = { ...s, claims: dC.claims, jobs: dC.jobs }
      const dR = Requests.jobFinished(s, i.id, i.outcome, ctx)
      s = { ...s, requests: dR.requests, jobs: dR.jobs, nextRequest: dR.nextRequest }
      const end = i.outcome._tag === "Reported"
        ? (i.outcome.report._tag === "Unknown" ? "unknown" : "found")
        : i.outcome._tag === "Failed" ? "failed" : i.outcome._tag === "TimedOut" ? "timedOut" : "cancelled"
      const detail = i.outcome._tag === "Reported"
        ? (i.outcome.report._tag === "Checked" ? i.outcome.report.fact : i.outcome.report._tag === "Answered" ? i.outcome.report.text : i.outcome.report.why)
        : i.outcome._tag === "Failed" ? i.outcome.reason : i.outcome._tag
      const by = i.outcome._tag === "Reported" ? i.outcome.report.by : "direct"
      const ms = Math.max(0, (ctx.now - job.startedAt) * 1000)
      const agentMove: Move = { _tag: "Reported", job: i.id, kind: job.kind, end, detail, by, ms }
      const subject = job.subject._tag === "Claim" ? s.claims.find((c) => c.id === job.subject.id) : undefined
      const overruled = subject?.phase._tag === "Closed" && subject.phase.why._tag === "Overruled"
      const note = (job.kind === "confirm" || job.kind === "recheck") && end === "found"
        ? (overruled ? "Staying quiet: the agent found the claim was right." : "Confirmed. Egg Head raises it at the next gap.")
        : undefined
      const base: Event = {
        ...blankEvent(s.turns.length - 1, "(agent)", ""),
        agent: {
          task: Number(String(i.id).split("/")[1] ?? 0),
          job: job.kind === "answer" ? "answer" : "confirm",
          action: end === "failed" || end === "timedOut" ? "failed" : "reported",
          detail,
          by,
          ms
        },
        moves: [agentMove, ...dC.moves, ...dR.moves],
        ...(job.subject._tag === "Claim" ? { claim: Number(String(job.subject.id).split(":")[0]) } : {}),
        ...(job.subject._tag === "Request"
          ? { request: Requests.toPublic(s.requests.find((r) => r.id === job.subject.id)!) }
          : {}),
        ...(note ? { note } : {})
      }
      const tail = speakTail(s, Floor.silence(s.floor, ctx.now, 0), ctx, base)
      // Job results should be events even without speech
      if (Option.isNone(tail.event)) return wrap(commitEvent(s, base, [...dC.commands, ...dR.commands], false))
      return wrap({ ...tail, commands: [...dC.commands, ...dR.commands, ...tail.commands] })
    }
    case "Composed": {
      if (s.floor.phase._tag !== "Composing" || s.floor.phase.id !== i.id) return wrap({ state: s, event: Option.none(), commands: [] })
      const draft = s.floor.phase.draft
      const text = Option.getOrElse(i.text, () => Option.getOrElse(draft.said, () => ""))
      const speech = draft.speech && Option.isSome(draft.speech) ? { ...draft.speech.value, text } : undefined
      s = { ...s, floor: Floor.composed(s.floor, i.id, ctx.now, ctx.tuning) }
      const ev = project({ ...draft, ...(speech ? { speech: Option.some(speech), said: Option.some(text) } : {}) })
      return wrap(commitEvent(s, ev, [], false))
    }
    case "SpeechEnded":
      return wrap({ state: { ...s, floor: Floor.ended(s.floor, i.id, ctx.now) }, event: Option.none(), commands: [] })
    case "Sweep":
      if (extraMoves.length === 0 && extraCommands.length === 0) return { state: s, event: Option.none(), commands: [] }
      return wrap(commitEvent(s, { ...blankEvent(s.turns.length - 1, "(silence)", ""), moves: extraMoves }, extraCommands, false))
  }
}

export const pending = (s: State): number =>
  Jobs.running(s.jobs).length +
  Claims.standing(s.claims).length +
  s.claims.filter((c) => c.retractionOwed).length +
  s.requests.filter((r) => r.phase._tag === "Listening" || r.phase._tag === "Ready").length
