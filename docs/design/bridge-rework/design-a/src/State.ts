/**
 * The vocabulary of the pure core: State, Input, Evidence, Command, Transition.
 *
 * Shape of a Bridge in one line:  gather (slow, unlocked)  ->  reduce (pure, instant)  ->  interpret (effects)
 * `reduce(state, input, ctx)` is total and deterministic; it cannot await a model. Every slow thing
 * the old `hear` did under the lock is either Evidence gathered before the reduce, or a Command
 * run after it whose completion comes back as another Input.
 */
import { Option } from "effect"
import type { Claims } from "./Claims.ts"
import type { Event, JobKind, Move } from "./Event.ts"
import type { Floor } from "./Floor.ts"
import type { JobId, SpeechId } from "./Ids.ts"
import type { Jobs, Job, Outcome } from "./Jobs.ts"
import type { Requests } from "./Requests.ts"
import type { Verdict } from "./Judgments.ts"
import type { Route } from "./Router.ts"
import type { Turn } from "./Questions.ts"
import type { TuningShape } from "./Tuning.ts"

export const WINDOW_TURNS = 12

/**
 * What the presence of an Investigator changes, as DATA read at three named places (Claims.observe
 * birth phase, Requests.intake, barge eligibility). There is no `agentMode` boolean elsewhere.
 */
export interface Policy {
  /** Contradicted claims get a second look; unconfirmed ones are tentative. Off: the fast check is final (born Standing, firm). */
  readonly secondLook: boolean
  /** Spoken-to replies and hanging questions. */
  readonly conversation: boolean
  /** Barge-in. On only with an Investigator: a tentative barge promises a check, and only an Investigator can keep that promise. */
  readonly barge: boolean
}
export const direct: Policy = { secondLook: false, conversation: false, barge: false }
export const investigated: Policy = { secondLook: true, conversation: true, barge: true }

export interface State {
  readonly turns: ReadonlyArray<Turn>
  /** Lines begun but not yet understood. >0 suppresses speech on ticks and barges (stale understanding). */
  readonly analysing: number
  readonly claims: Claims
  readonly requests: Requests
  readonly jobs: Jobs
  readonly floor: Floor
  /** Latest line-level signals, reused by silence ticks (was `gateSignals` + `finishedP`). */
  readonly finishedP: number
  readonly interruptP: number
  /** Partial bookkeeping, in state (was a Map outside the Ref): `${turn}|${claimId}` -> words last asked at. */
  readonly partials: Readonly<Record<string, number>>
  readonly escalations: number
  readonly notes: ReadonlyArray<string> // tick notes already shown, each once
  readonly nextSeq: number
  readonly events: ReadonlyArray<Event>
}

export interface Ctx {
  readonly now: number // Clock seconds, read once per input by the shell
  readonly tuning: TuningShape
  readonly policy: Policy
}

/** The result of every slice function: new slice + what happened + what to do after commit. */
export interface Stepped<S> {
  readonly state: S
  readonly moves: ReadonlyArray<Move>
  readonly commands: ReadonlyArray<Command>
}

/** Effects the reducer asks for. Only obtainable from a committed Transition (see Bridge.Committed). */
export type Command =
  | { readonly _tag: "StartJob"; readonly job: Job; readonly payload: JobPayload }
  | { readonly _tag: "CancelJob"; readonly id: JobId }
  | { readonly _tag: "Compose"; readonly id: SpeechId; readonly claim: string; readonly voice: string }

export type JobPayload =
  | { readonly kind: Extract<JobKind, "confirm" | "recheck">; readonly claim: Claims[number] }
  | { readonly kind: "answer"; readonly question: { readonly speaker: string; readonly text: string; readonly addressed: boolean } }

export interface LineEvidence {
  readonly deciderMs: number
  readonly route: Route
  readonly signals: Option.Option<{ finishedP: number; finishedRaw: number; selfRepairedP: number; addressedP: Option.Option<number>; asksP: Option.Option<number> }>
  readonly check: Option.Option<{ check: string; resource: string; status: string; evidence: string; verdict: "supports" | "contradicts" | "inconclusive"; asserted: Option.Option<string> }>
  readonly verdicts: ReadonlyArray<Verdict>
}
export interface PartialEvidence { readonly deciderMs: number; readonly actP: number; readonly verdicts: ReadonlyArray<Verdict> }

export type Input =
  | { readonly _tag: "LineBegan"; readonly speaker: string; readonly text: string; readonly silenceS: number }
  | { readonly _tag: "LineUnderstood"; readonly turn: number; readonly silenceS: number; readonly evidence: LineEvidence }
  | { readonly _tag: "LineFailed"; readonly turn: number; readonly reason: string } // gather failed or was interrupted: the turn still gets its terminal event
  | { readonly _tag: "Silence"; readonly silenceS: number }
  | { readonly _tag: "PartialHeard"; readonly speaker: string; readonly text: string; readonly claim: string; readonly evidence: PartialEvidence }
  | { readonly _tag: "JobDone"; readonly id: JobId; readonly outcome: Outcome }
  | { readonly _tag: "Composed"; readonly id: SpeechId; readonly text: Option.Option<string> } // None: writer failed; the code line is used
  | { readonly _tag: "SpeechEnded"; readonly id: SpeechId; readonly how: "finished" | "dropped" }
  | { readonly _tag: "Sweep" } // timer: retire expired jobs and floor phases with no other input

export interface Transition {
  readonly state: State
  /** Some when something the outside should see happened. Held back (not published) while a Compose is pending. */
  readonly event: Option.Option<Event>
  readonly commands: ReadonlyArray<Command>
}
