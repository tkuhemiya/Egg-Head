/**
 * Text-mode loop: utterance in, decision record out. Every decision is kept for the dashboard.
 *
 * hear(): route the latest utterance (Router.ts; Decider) and, while a claim is open, ask the
 *         gate questions in parallel -> run the check -> compare in code -> ledger -> gate ->
 *         maybe speak. Silence ticks reuse the last gate answers without a new utterance.
 *
 * With an Investigator (Investigator.ts; the demo's coding agent) the Bridge also:
 * - asks a second look before interrupting: a contradicted claim that survives one more turn
 *   without the call correcting it goes to the Investigator, and the gate only considers it
 *   once confirmed. A claim the call corrects first never costs a model call;
 * - answers when spoken to, once the speaker has finished, and takes questions the call
 *   leaves hanging (Conversation.ts);
 * - barges in from live partial transcripts (`partial`) when someone is about to act on a
 *   claim it knows is wrong.
 * Investigator jobs run in the background; their results come back through the same lock and
 * are spoken at the next moment the floor allows. Without an Investigator nothing changes.
 *
 * All call state lives in one Ref and is only touched while holding the Bridge's semaphore,
 * so `hear`, `tick`, `partial` and Investigator results never interleave. `run` turns a stream
 * of call inputs (transcript segments and VAD silence) into the stream of decisions;
 * `changes` broadcasts them.
 */
import { Clock, Context, Duration, Effect, Layer, Option, PubSub, Ref, Schema, Scope, Semaphore, Stream } from "effect"
import { type AiError, DecisionModel } from "effect/ai"
import { CheckSource } from "./Checks.ts"
import { compare, inferAsserted } from "./Compare.ts"
import * as C from "./Conversation.ts"
import * as G from "./Gate.ts"
import { direct, Investigator } from "./Investigator.ts"
import * as L from "./Ledger.ts"
import { finishedProbability, gateQuestions, renderGate, renderKv, type Turn } from "./Questions.ts"
import { aliasHits, Escalator, Route, route } from "./Router.ts"
import { type SupportError, Writer } from "./Speaker.ts"

export const WINDOW_TURNS = 12 // rolling window; the model context is 4,096 tokens

export const Verdict = Schema.Literals(["supports", "contradicts", "inconclusive"])

/** One Investigator job, as the dashboard shows it. */
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
  turn: Schema.Int,
  speaker: Schema.String,
  text: Schema.String,
  deciderMs: Schema.Number,
  route: Schema.OptionFromNullOr(Route),
  verdict: Schema.OptionFromNullOr(Verdict),
  checkEvidence: Schema.OptionFromNullOr(Schema.String),
  gate: Schema.OptionFromNullOr(G.GateDecision),
  /** Questions asked with this utterance: self_repaired, finished (Platt), finished_raw; addressed and asks with an Investigator. */
  gateScores: Schema.Record(Schema.String, Schema.Number),
  said: Schema.OptionFromNullOr(Schema.String),
  escalations: Schema.Int,
  /** With an Investigator: what Egg Head said it as, and what else happened on this step. */
  saidKind: Schema.optionalKey(Schema.Literals(["flag", "ack", "answer", "barge"])),
  agent: Schema.optionalKey(AgentNote),
  request: Schema.optionalKey(C.Request),
  note: Schema.optionalKey(Schema.String)
})
export type Event = typeof Event.Type

/** What the call feeds the Bridge: a final transcript segment, or more silence from VAD. */
export const CallInput = Schema.Union([
  Schema.TaggedStruct("Utterance", { speaker: Schema.String, text: Schema.String, silenceS: Schema.Number }),
  Schema.TaggedStruct("Silence", { silenceS: Schema.Number })
])
export type CallInput = typeof CallInput.Type

/** The last gate answers, reused by silence ticks. */
export interface GateSignals {
  readonly selfRepairedP: number
  readonly interruptP: number // 1 - P(finished), Platt-scaled
}

export interface BridgeState {
  readonly turns: ReadonlyArray<Turn>
  readonly ledger: L.Ledger
  readonly events: ReadonlyArray<Event>
  readonly escalations: number
  readonly lastSpokeS: number // Clock seconds; -Infinity until Egg Head first speaks
  readonly gateSignals: Option.Option<GateSignals>
  /** With an Investigator. */
  readonly requests: ReadonlyArray<C.Request>
  readonly tasks: number // Investigator jobs started
  readonly finishedP: number // Platt-scaled P(finished) of the latest line
  readonly notes: ReadonlyArray<string> // tick notes already shown (each once)
}

const initial: BridgeState = {
  turns: [],
  ledger: L.empty,
  events: [],
  escalations: 0,
  lastSpokeS: -Infinity,
  gateSignals: Option.none(),
  requests: [],
  tasks: 0,
  finishedP: 0.5,
  notes: []
}

const blankEvent = (turn: number, speaker: string, text: string): Event => ({
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
  escalations: 0
})

export type BridgeError = AiError.AiError | SupportError

export class Bridge extends Context.Service<Bridge, {
  hear(speaker: string, text: string, silenceS?: number): Effect.Effect<Event, BridgeError>
  /** More silence with no new utterance (from VAD). Re-runs the gate on the last answers. */
  tick(silenceS: number): Effect.Effect<Option.Option<Event>, SupportError>
  /**
   * A live partial transcript of the line still being spoken. Some(event) with `said` when
   * Egg Head barges in (the caller cuts the speaker off, then `hear`s what was said).
   */
  partial(speaker: string, text: string): Effect.Effect<Option.Option<Event>, BridgeError>
  run<E, R>(inputs: Stream.Stream<CallInput, E, R>): Stream.Stream<Event, E | BridgeError, R>
  readonly state: Effect.Effect<BridgeState>
  /** Investigator jobs running, and answers waiting to be said. */
  readonly pending: Effect.Effect<number>
  /** Every decision from now on, for the dashboard. */
  readonly changes: Stream.Stream<Event>
}>()("egghead/Bridge") {
  static readonly make = Effect.gen(function*() {
    const source = yield* CheckSource
    const writer = yield* Writer
    const escalator = yield* Effect.serviceOption(Escalator)
    const investigator = yield* Effect.serviceOption(Investigator)
    const decider = yield* DecisionModel.DecisionModel
    const scope = yield* Scope.Scope
    const state = yield* Ref.make(initial)
    const lock = yield* Semaphore.make(1)
    const pubsub = yield* PubSub.unbounded<Event>()
    const agentMode = Option.isSome(investigator)
    const nowS = Effect.map(Clock.currentTimeMillis, (ms) => ms / 1000)

    /** The open claim the gate looks at: the oldest, or with an Investigator the oldest it confirmed. */
    const gateItem = (s: BridgeState) =>
      agentMode ? L.open(s.ledger).find((i) => i.agent === "confirmed") : L.open(s.ledger)[0]

    const signalsOf = (s: BridgeState) =>
      Option.getOrElse(s.gateSignals, () => ({
        selfRepairedP: 0.0, // claim was just added this turn; the gate questions were not asked yet
        interruptP: 0.5
      }))

    /** Gate the oldest open claim and speak if it opens. Returns the new state and event. */
    const decide = Effect.fnUntraced(function*(s: BridgeState, ev: Event, silenceS: number, supportsOpen: boolean) {
      const item = gateItem(s)
      if (item === undefined) return [s, ev] as const
      const { selfRepairedP, interruptP } = signalsOf(s)
      const now = yield* nowS
      const gate = G.decide({
        check: item.check,
        status: item.status,
        laterTurns: s.turns.slice(item.turn + 1).map(([, text]) => text),
        silenceS,
        selfRepairedP,
        interruptP,
        laterClaimSupportsCheck: supportsOpen,
        secondsSinceLastSpoke: now - s.lastSpokeS
      })
      const decided = { ...ev, gate: Option.some(gate) }
      if (gate.speak) {
        const said = item.fact !== undefined ? C.flagLine(item.speaker, item.fact) : yield* writer.write(item)
        return [
          { ...s, ledger: L.markRaised(s.ledger, item), lastSpokeS: now },
          { ...decided, said: Option.some(said), ...(agentMode ? { saidKind: "flag" as const } : {}) }
        ] as const
      }
      if (Option.isSome(gate.repairedBy)) {
        // corrected by the call itself: close it, stay silent
        return [{ ...s, ledger: L.markRaised(s.ledger, item) }, decided] as const
      }
      return [s, decided] as const
    })

    const commit = (s: BridgeState, ev: Event) =>
      Ref.set(state, { ...s, events: [...s.events, ev] }).pipe(Effect.andThen(PubSub.publish(pubsub, ev)), Effect.as(ev))

    // -------------------------------------------------------------------------
    // Investigator jobs (only with an Investigator)
    // -------------------------------------------------------------------------

    /** Run a job in the background; its result comes back under the lock as its own event. */
    const background = <A>(
      job: Effect.Effect<A, SupportError>,
      fallback: Effect.Effect<A, SupportError>,
      done: (s: BridgeState, result: A, by: string, ms: number) => Effect.Effect<readonly [BridgeState, Event], SupportError>
    ) =>
      Effect.timed(job.pipe(
        Effect.map((a) => [a, "agent"] as const),
        Effect.catch(() => Effect.map(fallback, (a) => [a, "direct (agent failed)"] as const))
      )).pipe(
        Effect.flatMap(([elapsed, [result, by]]) =>
          lock.withPermits(1)(Effect.gen(function*() {
            const [next, ev] = yield* done(yield* Ref.get(state), result, by, Duration.toMillis(elapsed))
            yield* commit(next, ev)
          }))
        ),
        Effect.catchCause(Effect.logError),
        Effect.forkIn(scope)
      )

    /** Start the second look at a contradicted claim. Returns the new state and the job to fork. */
    const confirmClaim = (s: BridgeState, item: L.LedgerItem, inv: Investigator["Service"]) => {
      const task = s.tasks + 1
      const fallback = Effect.succeed({ status: item.status, fact: C.factOf(item), by: "direct" })
      const job = background(inv.confirm(task, item), fallback, (now, finding, by, ms) =>
        Effect.sync(() => {
          const current = L.find(now.ledger, item)
          const asserted = item.asserted ?? inferAsserted(item.claim)
          const stillWrong = compare(asserted, finding.status) === "contradicts"
          const note: AgentNote = {
            task,
            job: "confirm",
            action: "reported",
            detail: stillWrong ? `confirmed: ${finding.fact}` : `overruled the fast check: ${finding.status} (${finding.fact})`,
            by,
            ms
          }
          const ledger = current === undefined || current.raised
            ? now.ledger
            : L.update(now.ledger, item, stillWrong
              ? { agent: "confirmed", fact: finding.fact }
              : { agent: "overruled", fact: finding.fact, raised: true })
          const ev: Event = {
            ...blankEvent(now.turns.length - 1, "(agent)", ""),
            agent: note,
            note: current?.raised
              ? "Already raised or corrected by the time the agent reported."
              : stillWrong
              ? "Confirmed. Egg Head raises it at the next gap."
              : "Staying quiet: the agent found the claim was right."
          }
          return [{ ...now, ledger }, ev] as const
        }))
      return [{ ...s, tasks: task, ledger: L.update(s.ledger, item, { agent: "checking" }) }, job] as const
    }

    /** Start answering a question. Returns the new state and the job to fork. */
    const answerRequest = (s: BridgeState, req: C.Request, inv: Investigator["Service"]) => {
      const task = s.tasks + 1
      const question = { speaker: req.speaker, text: req.text, addressed: req.kind === "addressed" }
      const job = background(inv.answer(task, question), direct(source).answer(task, question), (now, answer, by, ms) =>
        Effect.sync(() => {
          const requests = now.requests.map((r) =>
            r.id === req.id && r.state === "checking"
              ? { ...r, state: "ready" as const, answer: Option.some(answer), note: "answer ready; waiting for a gap" }
              : r
          )
          const ev: Event = {
            ...blankEvent(now.turns.length - 1, "(agent)", ""),
            agent: { task, job: "answer", action: "reported", detail: answer, by, ms },
            request: requests.find((r) => r.id === req.id)!
          }
          return [{ ...now, requests }, ev] as const
        }))
      const next = {
        ...s,
        tasks: task,
        requests: s.requests.map((r) => (r.id === req.id ? { ...r, state: "checking" as const, note: `agent task ${task}` } : r))
      }
      return [next, job] as const
    }

    // -------------------------------------------------------------------------
    // Speaking on a step: answers, replies, then the claim gate
    // -------------------------------------------------------------------------

    const dispatched = (task: number, job: "confirm" | "answer", detail: string): AgentNote => ({ task, job, action: "dispatched", detail })

    const floorOpen = (s: BridgeState, silenceS: number) =>
      silenceS >= G.T_MIN_SILENCE_S && (s.finishedP >= G.T_FLOOR || silenceS >= G.T_SILENCE_S)

    /** With an Investigator: say a ready answer, or reply to a finished question, if the floor allows. */
    const converse = Effect.fnUntraced(function*(s: BridgeState, ev: Event, silenceS: number, inv: Investigator["Service"]) {
      const ready = s.requests.find((r) => r.state === "ready")
      if (ready && floorOpen(s, silenceS)) {
        const said = C.answerLine(ready.speaker, Option.getOrElse(ready.answer, () => ""))
        const req = { ...ready, state: "answered" as const, note: "answered" }
        return [
          { ...s, requests: s.requests.map((r) => (r.id === ready.id ? req : r)) },
          { ...ev, said: Option.some(said), saidKind: "answer" as const, request: req },
          true
        ] as const
      }
      const listening = s.requests.find((r) => r.state === "listening")
      if (listening && silenceS >= G.T_MIN_SILENCE_S) {
        const latestBy = s.turns[s.turns.length - 1]?.[0]
        if (listening.kind === "addressed") {
          const r = C.readyToReply({ finishedP: s.finishedP, text: listening.text, silenceS })
          if (!r.ready) {
            const note = `${listening.speaker} is talking to Egg Head but has not finished: ${r.why}. Waiting.`
            if (silenceS >= 1.0 && !s.notes.includes(`${listening.id}:${r.why}`)) {
              const vad = silenceS >= 0.8 ? ` A silence-based end-of-turn detector would have replied at ${silenceS.toFixed(1)} s.` : ""
              return [{ ...s, notes: [...s.notes, `${listening.id}:${r.why}`] }, { ...ev, note: note + vad, request: listening }, false] as const
            }
            return [s, ev, false] as const
          }
          const [asked, job] = answerRequest(s, listening, inv)
          yield* job
          const req = { ...asked.requests.find((x) => x.id === listening.id)!, note: `${r.why}; investigating` }
          return [
            { ...asked, requests: asked.requests.map((x) => (x.id === req.id ? req : x)) },
            { ...ev, said: Option.some(C.ackLine(listening.speaker)), saidKind: "ack" as const, request: req, agent: dispatched(asked.tasks, "answer", listening.text) },
            true
          ] as const
        }
        if (latestBy === listening.speaker && silenceS >= C.OPEN_SILENCE_S) {
          const [asked, job] = answerRequest(s, listening, inv)
          yield* job
          const req = { ...asked.requests.find((x) => x.id === listening.id)!, note: `nobody answered in ${silenceS.toFixed(1)} s; Egg Head takes it` }
          return [
            { ...asked, requests: asked.requests.map((x) => (x.id === req.id ? req : x)) },
            { ...ev, said: Option.some(C.OPEN_ACK), saidKind: "ack" as const, request: req, agent: dispatched(asked.tasks, "answer", listening.text) },
            true
          ] as const
        }
      }
      return [s, ev, false] as const
    })

    /** One speaking decision per step: answers and replies first, then the claim gate. */
    const step = Effect.fnUntraced(function*(s: BridgeState, ev: Event, silenceS: number, supportsOpen: boolean) {
      if (Option.isSome(investigator)) {
        const [next, decided, spoke] = yield* converse(s, ev, silenceS, investigator.value)
        if (spoke) return [next, decided] as const
        return yield* decide(next, decided, silenceS, supportsOpen)
      }
      return yield* decide(s, ev, silenceS, supportsOpen)
    })

    // -------------------------------------------------------------------------
    // hear / tick / partial
    // -------------------------------------------------------------------------

    const hear = (speaker: string, text: string, silenceS = 0) =>
      lock.withPermits(1)(Effect.gen(function*() {
        const heard = yield* Ref.updateAndGet(state, (s) => ({ ...s, turns: [...s.turns, [speaker, text] as const] }))
        const window = heard.turns.slice(-WINDOW_TURNS)
        const openItems = L.open(heard.ledger)
        const inventory = yield* source.inventory
        const gateState = renderGate(window, silenceS, openItems)
        const askGate = Effect.map(decider.decide(gateQuestions, { input: gateState }), ({ answers }) => answers)
        const askTurn = Effect.map(decider.decide(C.turnQuestions, { input: gateState }), ({ answers }) => answers)
        const [elapsed, [routed, gateAnswers]] = yield* Effect.timed(Effect.all([
          route(window, inventory).pipe(Effect.provideService(DecisionModel.DecisionModel, decider)),
          agentMode ? Effect.asSome(askTurn) : openItems.length > 0 ? Effect.asSome(askGate) : Effect.succeedNone
        ], { concurrency: "unbounded" }))
        const finished = Option.map(gateAnswers, (a) => finishedProbability(a.fin.probability))
        let s: BridgeState = Option.isSome(gateAnswers) && Option.isSome(finished) && openItems.length > 0
          ? { ...heard, gateSignals: Option.some({ selfRepairedP: gateAnswers.value.rep.probability, interruptP: 1 - finished.value }) }
          : heard
        if (Option.isSome(finished)) s = { ...s, finishedP: finished.value }
        const turnScores = Option.match(gateAnswers, {
          onNone: () => ({}),
          onSome: (a) => ({
            self_repaired: a.rep.probability,
            finished: finished.pipe(Option.getOrElse(() => 0)),
            finished_raw: a.fin.probability,
            ..."addr" in a ? { addressed: (a as C.TurnAnswers).addr.probability, asks: (a as C.TurnAnswers).ask.probability } : {}
          })
        })
        let ev: Event = {
          ...blankEvent(heard.turns.length - 1, speaker, text),
          deciderMs: Duration.toMillis(elapsed),
          gateScores: agentMode || openItems.length > 0 ? turnScores : {}
        }

        let rt = routed
        ev = { ...ev, route: Option.some(rt) }
        if (rt.action === "escalate") {
          s = { ...s, escalations: s.escalations + 1 }
          ev = { ...ev, escalations: s.escalations }
          if (Option.isSome(escalator)) {
            const decided = rt
            rt = yield* escalator.value.route(window)
            rt = { ...rt, scores: { ...decided.scores, ...rt.scores } } // keep Decider's scores beside the escalator's
            ev = { ...ev, route: Option.some(rt) }
          }
        }

        // With an Investigator: claims that survived a turn uncorrected get their second look now.
        if (Option.isSome(investigator)) {
          for (const item of L.open(s.ledger).filter((i) => i.agent === "pending" && i.turn < ev.turn)) {
            const rep = G.repairedBy({
              check: item.check,
              status: item.status,
              laterTurns: s.turns.slice(item.turn + 1).map(([, t]) => t),
              silenceS,
              ...signalsOf(s),
              laterClaimSupportsCheck: false
            })
            if (Option.isSome(rep)) {
              s = { ...s, ledger: L.update(s.ledger, item, { agent: "skipped", raised: true }) }
              ev = { ...ev, note: `${item.speaker}'s claim was corrected by the call (${rep.value}) before any LLM call. Staying quiet.` }
            } else {
              const [next, job] = confirmClaim(s, item, investigator.value)
              yield* job
              s = next
              ev = { ...ev, agent: dispatched(s.tasks, "confirm", `${item.speaker}: "${item.claim}" (fast check: ${item.check} on ${item.resource} is ${item.status})`) }
            }
          }
        }

        let supportsOpen = false
        if (rt.action === "check" && Option.isSome(rt.check) && Option.isSome(rt.resource)) {
          const [check, resource] = [rt.check.value, rt.resource.value]
          const res = yield* source.run(check, resource)
          if (Option.isSome(res)) {
            const asserted = Option.getOrNull(rt.asserted)
            const claimed = asserted === "unclear" ? inferAsserted(text) : asserted
            const verdict = compare(claimed, res.value.status)
            ev = { ...ev, verdict: Option.some(verdict), checkEvidence: Option.some(res.value.evidence) }
            if (verdict === "contradicts") {
              s = {
                ...s,
                ledger: L.add(s.ledger, {
                  speaker,
                  claim: text,
                  check,
                  resource,
                  status: res.value.status,
                  evidence: res.value.evidence,
                  turn: ev.turn,
                  raised: false,
                  ...(agentMode ? { agent: "pending" as const, ...(claimed ? { asserted: claimed } : {}) } : {})
                })
              }
            } else if (verdict === "supports") {
              supportsOpen = openItems.some((i) => i.check === check && i.resource === resource)
            }
          }
        }

        if (agentMode && Option.isSome(gateAnswers)) {
          const a = gateAnswers.value as C.TurnAnswers
          const listening = s.requests.find((r) => r.state === "listening")
          if (listening?.kind === "addressed" && listening.speaker === speaker) {
            // the same person still asking: one question across their segments
            const req = { ...listening, text: `${listening.text} ${text}`, note: "still asking" }
            s = { ...s, requests: s.requests.map((r) => (r.id === req.id ? req : r)) }
            ev = { ...ev, request: req }
          } else if (C.namesEggHead(text) && a.addr.probability >= C.T_ADDRESSED) {
            const req: C.Request = {
              id: s.requests.length + 1, kind: "addressed", speaker, text, turn: ev.turn, state: "listening",
              answer: Option.none(), note: `asked Egg Head (Decider ${a.addr.probability.toFixed(2)})`
            }
            s = { ...s, requests: [...s.requests.map(dropOpen(speaker)), req] }
            ev = { ...ev, request: req }
          } else if (C.isQuestion(text) && a.ask.probability >= C.T_ASKS && rt.action !== "check") {
            const req: C.Request = {
              id: s.requests.length + 1, kind: "open", speaker, text, turn: ev.turn, state: "listening",
              answer: Option.none(), note: `question to the call (Decider ${a.ask.probability.toFixed(2)}); waiting to see if anyone answers`
            }
            s = { ...s, requests: [...s.requests.map(dropOpen(speaker)), req] }
            ev = { ...ev, request: req }
          } else {
            const dropped = s.requests.find((r) => r.kind === "open" && r.state === "listening" && r.speaker !== speaker)
            if (dropped) {
              const req = { ...dropped, state: "dropped" as const, note: `${speaker} answered; Egg Head stays out` }
              s = { ...s, requests: s.requests.map((r) => (r.id === req.id ? req : r)) }
              ev = { ...ev, request: req }
            }
          }
        }

        const [next, decided] = yield* step(s, ev, silenceS, supportsOpen)
        return yield* commit(next, decided)
      }))

    const dropOpen = (speaker: string) => (r: C.Request): C.Request =>
      r.kind === "open" && r.state === "listening" ? { ...r, state: "dropped", note: `${speaker} moved on` } : r

    const tick = (silenceS: number) =>
      lock.withPermits(1)(Effect.gen(function*() {
        const s = yield* Ref.get(state)
        if (s.events.length === 0) return Option.none<Event>()
        if (!agentMode) {
          if (L.open(s.ledger).length === 0) return Option.none<Event>()
          const [next, decided] = yield* decide(s, blankEvent(s.turns.length - 1, "(silence)", ""), silenceS, false)
          return Option.some(yield* commit(next, decided))
        }
        // With an Investigator, a tick is only an event when something happens on it.
        const blank = blankEvent(s.turns.length - 1, "(silence)", "")
        const [next, decided] = yield* step(s, blank, silenceS, false)
        const happened = Option.isSome(decided.said) || decided.note !== undefined || decided.request !== undefined ||
          next.ledger !== s.ledger
        if (!happened) return Option.none<Event>()
        return Option.some(yield* commit(next, decided))
      }))

    // Which (line, resource) pairs a partial already asked about, and at how many words.
    const asked = new Map<string, number>()

    const partial = (speaker: string, text: string) =>
      lock.withPermits(1)(Effect.gen(function*() {
        const s = yield* Ref.get(state)
        const named = new Set(aliasHits(text))
        const item = L.open(s.ledger).find((i) => named.has(i.resource))
        if (item === undefined) return Option.none<Event>()
        const key = `${s.turns.length}|${item.resource}`
        const words = text.split(/\s+/).length
        const last = asked.get(key)
        if (last !== undefined && words < last + 2) return Option.none<Event>() // ask again only once more words are in
        asked.set(key, words)
        const window = [...s.turns.slice(-WINDOW_TURNS), [speaker, text] as const]
        const [elapsed, { answers }] = yield* Effect.timed(decider.decide(C.directiveQuestions, { input: renderKv(window, 1) }))
        const act = answers.act.probability
        const ev: Event = {
          ...blankEvent(s.turns.length, speaker, text),
          deciderMs: Duration.toMillis(elapsed),
          gateScores: { directive: act }
        }
        if (act < C.T_DIRECTIVE) {
          return Option.some(yield* commit(s, { ...ev, note: `Mentions ${item.resource} (open claim) but Decider says it is not an instruction to act (${act.toFixed(2)}).` }))
        }
        const fact = item.fact ?? C.factOf(item)
        const now = yield* nowS
        return Option.some(yield* commit(
          { ...s, ledger: L.markRaised(s.ledger, item), lastSpokeS: now },
          {
            ...ev,
            said: Option.some(C.bargeLine(speaker, fact)),
            saidKind: "barge",
            note: `${speaker} is about to act on ${item.resource} (Decider ${act.toFixed(2)}), but ${item.speaker}'s claim about it is wrong. Interrupting is cheaper than waiting.`
          }
        ))
      }))

    const run = <E, R>(inputs: Stream.Stream<CallInput, E, R>) =>
      inputs.pipe(
        Stream.mapEffect((input) =>
          input._tag === "Utterance"
            ? Effect.map(hear(input.speaker, input.text, input.silenceS), (ev) => [ev])
            : Effect.map(tick(input.silenceS), Option.toArray) // a tick with nothing open emits nothing
        ),
        Stream.flattenIterable
      )

    const pending = Effect.map(Ref.get(state), (s) =>
      L.open(s.ledger).filter((i) => i.agent === "checking" || i.agent === "confirmed").length +
      s.requests.filter((r) => r.state === "checking" || r.state === "ready" || r.state === "listening").length)

    return Bridge.of({ hear, tick, partial, run, state: Ref.get(state), pending, changes: Stream.fromPubSub(pubsub) })
  })

  /** Needs a DecisionModel (Decider.ts), a CheckSource and a Writer; Escalator and Investigator are optional. */
  static readonly layer = Layer.effect(Bridge, Bridge.make)
}
