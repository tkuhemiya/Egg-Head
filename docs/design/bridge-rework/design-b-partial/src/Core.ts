/**
 * Core: the Bridge as a pure reducer. `reduce(state, input, now)` returns the next state, the
 * event to log (if any) and, when the step needs something slow, a description of it (`Then`).
 *
 * The Bridge shell (Bridge.ts) is a small interpreter around this:
 *   1. apply an input atomically: one SubscriptionRef.modify(reduce). That single write is the
 *      commit; events are part of state, so publishing is derived, never a second write.
 *   2. if the step returned `then`, do the slow thing (Decider, check, Bedrock writer) with no
 *      lock held, and feed the result back as the next input (2 of the inputs below are such
 *      results: Heard, PartialRead, Written).
 *   3. jobs in state are started by the runner, after commit (Jobs.ts).
 * So nothing slow ever sits between reading state and writing it, and every input sees the
 * state as it is when it applies, not when its slow part began. Each `apply*` re-checks its
 * guards against that state (a barge on a claim closed meanwhile is dropped).
 *
 * The order of transitions inside one heard line is fixed here, once:
 *   expire deadlines -> close what the line corrected (Reading + a supporting check) or parked
 *   -> second look for claims that survived a turn -> admit the line's own contradicted claim
 *   -> requests -> Policy.choose. (Today's agent mode dispatched second looks before routing
 *   the line, so a later true claim could not repair an earlier one: finding 5.)
 *
 * TLA+: each Input tag is one action of spec/Bridge.tla (same names; SpecSync.test.ts checks
 * the lists), and the spec's invariants are about Claims/Requests/Speech transitions this file
 * composes, so a change here that the spec does not have fails a test, not a review.
 */
import { Option } from "effect"
import type { Claim } from "./Claims.ts"
import type { Event, JobId, UtteranceId } from "./Event.ts"
import type { Job, JobResult } from "./Jobs.ts"
import type { Observation, PartialObservation } from "./Observe.ts"
import type { Turn } from "./Questions.ts"
import type { Request } from "./Requests.ts"
import type { Speech, Unprompted } from "./Speech.ts"
import type { TuningShape } from "./Tuning.ts"

// ---------------------------------------------------------------------------
// Mode: every difference between "with" and "without an Investigator", in one record
// ---------------------------------------------------------------------------

export interface Mode {
  /** A new contradicted claim is gateable at once ("gate"), or waits a turn for a second look. */
  readonly admit: "gate" | "secondLook"
  /** Requests (spoken to, hanging questions) exist. */
  readonly requests: boolean
  /** Barge-in from partials exists. Without an Investigator: no (proposal; rationale.md). */
  readonly barge: boolean
  /** Turn questions: rep + fin only while a claim is open (parity), or rep, fin, addr, ask on every line. */
  readonly turnQuestions: "whileClaimOpen" | "always"
  /** A silence tick logs an event whenever a claim is open (parity), or only when something happens. */
  readonly tickEvents: "whileClaimOpen" | "whenSomethingHappens"
}

export const PLAIN: Mode = { admit: "gate", requests: false, barge: false, turnQuestions: "whileClaimOpen", tickEvents: "whileClaimOpen" }
export const AGENT: Mode = { admit: "secondLook", requests: true, barge: true, turnQuestions: "always", tickEvents: "whenSomethingHappens" }

// ---------------------------------------------------------------------------
// State: one value, one owner (the Bridge's SubscriptionRef); every field written only here
// ---------------------------------------------------------------------------

export interface State {
  readonly turns: ReadonlyArray<Turn>
  /** Turns appended but not analysed yet, oldest first (hears are applied in arrival order). */
  readonly analysing: ReadonlyArray<number>
  readonly claims: ReadonlyArray<Claim>
  readonly requests: ReadonlyArray<Request>
  readonly jobs: ReadonlyArray<Job>
  readonly speech: Speech
  readonly unprompted: Unprompted
  /** Latest line's Platt-scaled finished, and the gate signals as today (stale-signal quirk kept for parity; W5). */
  readonly line: { readonly finishedP: number; readonly gateSignals: Option.Option<{ readonly selfRepairedP: number; readonly interruptP: number }> }
  /** Partial bookkeeping for the line in progress (was the `asked` Map outside the Ref). Reset when a turn is appended. */
  readonly partial: { readonly turn: number; readonly askedAt: Readonly<Record<string, number>> } // resource -> words when asked
  /** Notes already shown once (reply-wait notes). */
  readonly shown: ReadonlyArray<string>
  readonly escalations: number
  /** One counter for claim, request, job and utterance ids. */
  readonly nextId: number
  readonly events: ReadonlyArray<Event>
}

export const initial: State = null as never // TODO: empty state

// ---------------------------------------------------------------------------
// Inputs: what can happen to the Bridge. Exactly the actions of spec/Bridge.tla.
// ---------------------------------------------------------------------------

export type Input =
  /** hear(): a final transcript segment arrived. Appends the turn now; analysis follows. */
  | { readonly _tag: "Utterance"; readonly speaker: string; readonly text: string; readonly silenceS: number }
  /** The analysis of turn `turn` (or why it failed). Applied strictly in turn order. */
  | { readonly _tag: "Heard"; readonly turn: number; readonly silenceS: number; readonly observation: Observation | { readonly _tag: "Failed"; readonly cause: string } }
  /** tick(): more silence. */
  | { readonly _tag: "Silence"; readonly silenceS: number }
  /** partial(): words of a line still being spoken. */
  | { readonly _tag: "Partial"; readonly speaker: string; readonly text: string }
  /** Decider's `act` on that partial. */
  | { readonly _tag: "PartialRead"; readonly turn: number; readonly speaker: string; readonly text: string; readonly observation: PartialObservation }
  /** The Writer's line for a flag the policy chose (or its failure: then the template line). */
  | { readonly _tag: "Written"; readonly claim: Claim["id"]; readonly text: string; readonly pending: Event }
  /** Runner: a Queued job is about to be forked. */
  | { readonly _tag: "JobStarted"; readonly job: JobId }
  | { readonly _tag: "JobDone"; readonly job: JobId; readonly outcome: { readonly _tag: "Reported"; readonly result: JobResult } | { readonly _tag: "Failed"; readonly cause: string } }
  /** finished(): the caller says Egg Head's clip ended (or was never voiced). */
  | { readonly _tag: "Finished"; readonly utterance: UtteranceId }

export const INPUT_TAGS: ReadonlyArray<Input["_tag"]> = ["Utterance", "Heard", "Silence", "Partial", "PartialRead", "Written", "JobStarted", "JobDone", "Finished"]

/** The slow work a step asks for. The shell runs it without holding anything and feeds back the result. */
export type Then =
  | { readonly _tag: "Observe"; readonly turn: number; readonly snapshot: State } // -> Heard
  | { readonly _tag: "AskAct"; readonly turn: number; readonly speaker: string; readonly text: string; readonly snapshot: State } // -> PartialRead
  | { readonly _tag: "Write"; readonly claim: Claim; readonly pending: Event } // -> Written

export interface Step {
  readonly state: State
  /** Without `seq`: the shell stamps it in the same modify. */
  readonly event: Option.Option<Omit<Event, "seq">>
  readonly then: Option.Option<Then>
}

export const reduce = (s: State, input: Input, now: number, mode: Mode, t: TuningShape): Step => {
  throw new Error("not implemented")
  // const s0 = expire(s, now, t)                       // jobs past deadline settle their owners; Speech past maxLineS -> Quiet
  // switch (input._tag) {
  //   case "Utterance":  append turn; analysing += turn; Speech.heardHuman; partial = { turn: turn + 1, askedAt: {} }
  //                      -> then Observe{turn, snapshot}; no event (the turn's one event comes with Heard)
  //   case "Heard":      must be analysing[0] (else no-op: duplicate); heard(s0, input) below
  //   case "Silence":    Policy.choose -> maybe said / Write; event per mode.tickEvents
  //   case "Partial":    partialPlan: mode.barge, Speech.mayBarge, Claims.bargeTarget over aliasHits(text),
  //                      2+ new words since askedAt[resource]; record askedAt -> then AskAct
  //   case "PartialRead": stale if turns.length !== input.turn (the line was heard already) -> no-op;
  //                      re-check bargeTarget and mayBarge on the current state; act >= t.directive ->
  //                      said{barge, certainty, basis}, Claims.barged (queues confirm if Contradicted),
  //                      unprompted.lastAt = now, Speech.speak; else a note event
  //   case "Written":    Speech must be Writing{claim} and the claim still Confirmed, else drop with a note;
  //                      said{flag}, Claims.flagged, unprompted.lastAt = now, Speech.speak; event = pending + said
  //   case "JobStarted": Jobs.start; no event
  //   case "JobDone":    Jobs.finish (None -> no-op) -> owner: Claims.settleJob (may queue recheck) | Requests.settleJob
  //   case "Finished":   Speech.finished; no event
  // }
}

/** The heard-line step, in the fixed order above. */
export const heard = (s: State, input: Extract<Input, { _tag: "Heard" }>, now: number, mode: Mode, t: TuningShape): Step => {
  throw new Error("not implemented")
}

/** What `Bridge.pending` reports: work Egg Head still owes the call (not claims the gate keeps blocking; gotcha 12). */
export const pending = (s: State): number => {
  throw new Error("not implemented")
  // open jobs + Listening addressed + Ready requests + Correcting claims + analysing turns + (Speech !== Quiet)
}
