/**
 * Vocabulary of the pure core: State, Input, Evidence, Command, Transition.
 */
import { Option } from "effect"
import type { Claim } from "./Claims.ts"
import type { Event, JobKind, Move } from "./Event.ts"
import type { Floor } from "./Floor.ts"
import type { JobId, SpeechId } from "./Ids.ts"
import type { Job, Jobs, Outcome } from "./Jobs.ts"
import type { Verdict } from "./Judgments.ts"
import type { Route } from "./Router.ts"
import type { Turn } from "./Questions.ts"
import type { Request } from "./Requests.ts"
import type { TuningShape } from "./Tuning.ts"

export const WINDOW_TURNS = 12
export const INPUT_TAGS = [
  "LineBegan", "LineUnderstood", "LineFailed", "Silence", "PartialHeard",
  "JobDone", "Composed", "SpeechEnded", "Sweep"
] as const

export interface Policy {
  readonly secondLook: boolean
  readonly conversation: boolean
  readonly barge: boolean
}
export const direct: Policy = { secondLook: false, conversation: false, barge: false }
export const investigated: Policy = { secondLook: true, conversation: true, barge: true }

export interface State {
  readonly turns: ReadonlyArray<Turn>
  readonly analysing: number
  readonly claims: ReadonlyArray<Claim>
  readonly requests: ReadonlyArray<Request>
  readonly jobs: Jobs
  readonly floor: Floor
  readonly finishedP: number
  readonly interruptP: number
  readonly selfRepairedP: number
  readonly partials: Readonly<Record<string, number>>
  readonly escalations: number
  readonly notes: ReadonlyArray<string>
  readonly nextSeq: number
  readonly nextRequest: number
  readonly events: ReadonlyArray<Event>
  readonly epoch: string
}

export const empty = (epoch: string): State => ({
  turns: [],
  analysing: 0,
  claims: [],
  requests: [],
  jobs: { epoch, next: 1, table: {} },
  floor: {
    phase: { _tag: "Open" },
    lastEndedAt: Option.none(),
    turnAtLastLine: Option.none(),
    lastUnpromptedAt: Option.none(),
    seq: 0
  },
  finishedP: 0.5,
  interruptP: 0.5,
  selfRepairedP: 0,
  partials: {},
  escalations: 0,
  notes: [],
  nextSeq: 0,
  nextRequest: 1,
  events: [],
  epoch
})

export interface Ctx {
  readonly now: number
  readonly tuning: TuningShape
  readonly policy: Policy
}

export type Command =
  | { readonly _tag: "StartJob"; readonly job: Job; readonly payload: JobPayload }
  | { readonly _tag: "CancelJob"; readonly id: JobId }
  | { readonly _tag: "Compose"; readonly id: SpeechId; readonly claim: Claim }

export type JobPayload =
  | { readonly kind: Extract<JobKind, "confirm" | "recheck">; readonly claim: Claim }
  | { readonly kind: "answer"; readonly question: { readonly speaker: string; readonly text: string; readonly addressed: boolean } }

export interface LineEvidence {
  readonly deciderMs: number
  readonly route: Route
  /** Decider asked to escalate, even if an Escalator then produced a route. */
  readonly handedOff: boolean
  readonly signals: Option.Option<{
    finishedP: number
    finishedRaw: number
    selfRepairedP: number
    addressedP: Option.Option<number>
    asksP: Option.Option<number>
  }>
  readonly check: Option.Option<{
    check: string
    resource: string
    status: string
    evidence: string
    verdict: "supports" | "contradicts" | "inconclusive"
    asserted: Option.Option<string>
  }>
  readonly verdicts: ReadonlyArray<Verdict>
}

export interface PartialEvidence {
  readonly deciderMs: number
  readonly actP: number
  readonly verdicts: ReadonlyArray<Verdict>
}

export type Input =
  | { readonly _tag: "LineBegan"; readonly speaker: string; readonly text: string; readonly silenceS: number }
  | { readonly _tag: "LineUnderstood"; readonly turn: number; readonly silenceS: number; readonly evidence: LineEvidence }
  | { readonly _tag: "LineFailed"; readonly turn: number; readonly reason: string }
  | { readonly _tag: "Silence"; readonly silenceS: number }
  | { readonly _tag: "PartialHeard"; readonly speaker: string; readonly text: string; readonly claim: string; readonly evidence: PartialEvidence }
  | { readonly _tag: "JobDone"; readonly id: JobId; readonly outcome: Outcome }
  | { readonly _tag: "Composed"; readonly id: SpeechId; readonly text: Option.Option<string> }
  | { readonly _tag: "SpeechEnded"; readonly id: SpeechId; readonly how: "finished" | "dropped" }
  | { readonly _tag: "Sweep" }

export interface Transition {
  readonly state: State
  readonly event: Option.Option<Event>
  readonly commands: ReadonlyArray<Command>
}

export const noop = (s: State): Transition => ({ state: s, event: Option.none(), commands: [] })
