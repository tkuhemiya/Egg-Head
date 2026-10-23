/**
 * Observe: the slow, read-only part of hearing a line. Everything that waits on Decider, the
 * fast check, the Escalator or the seam happens here, against a snapshot, with nothing held.
 * It returns an Observation; Core applies it to whatever the state is by then.
 *
 * No writes, no forks: running it twice gives the same answers (the Decider provider caches
 * identical requests), so a retried analysis is harmless.
 *
 * Each call is bounded by Tuning.observeS (finding: the Decider timeout sits outside its queue,
 * gotcha 2). A timeout becomes Heard{Failed}, which still logs the turn's one event.
 */
import { Effect, Option } from "effect"
import type { AiError, DecisionModel } from "effect/ai"
import type { CheckSource } from "./Checks.ts"
import type { Mode, State } from "./Core.ts"
import type { TurnAnswers } from "./Conversation.ts"
import type { Verdict } from "./Event.ts"
import type { Reading, Readings } from "./Reading.ts"
import type { LineAsk } from "./Requests.ts"
import type { Escalator, Route } from "./Router.ts"
import type { SupportError } from "./Speaker.ts"

export interface Observation {
  readonly _tag: "Observed"
  readonly deciderMs: number
  readonly route: Route // after the Escalator, when one re-routed it
  readonly escalated: boolean
  /** rep, fin (Platt), and with Mode.requests addr, ask. None when the mode did not ask. */
  readonly turn: Option.Option<{ readonly selfRepairedP: number; readonly finishedRaw: number; readonly finishedP: number; readonly addr?: number; readonly ask?: number }>
  /** The fast check for a `check` route. */
  readonly check: Option.Option<{
    readonly check: string
    readonly resource: string
    readonly asserted: Option.Option<string>
    readonly status: string
    readonly evidence: string
    readonly verdict: typeof Verdict.Type
  }>
  /** The seam's judgments about every live claim, parked resource and open question in the snapshot. */
  readonly readings: Readings
  /** What this line means for requests (code: name regex, "?", plus addr/ask). Other when Mode.requests is off. */
  readonly ask: LineAsk
}

export interface PartialObservation {
  readonly deciderMs: number
  readonly resource: string
  readonly actP: number
}

export const observe = (
  snapshot: State,
  turn: number,
  silenceS: number,
  mode: Mode
): Effect.Effect<Observation, AiError.AiError | SupportError, DecisionModel.DecisionModel | CheckSource | Reading> => {
  throw new Error("not implemented")
  // window = snapshot.turns up to `turn`, last 12
  // in parallel: Router.route(window) | turn questions per mode.turnQuestions (renderGate)
  // escalate -> Escalator.route (optional service, bounded by Tuning.writeS)
  // check route -> source.run -> compare (inferAsserted on "unclear")
  // Reading.read({ live claims with lines since each, resources of live claims, Listening open requests, rep })
}

export const observePartial = (
  snapshot: State,
  speaker: string,
  text: string,
  resource: string
): Effect.Effect<PartialObservation, AiError.AiError, DecisionModel.DecisionModel> => {
  throw new Error("not implemented") // the `act` question on the latest line, kv format (Conversation.directiveQuestions)
}

// Escalator kept as an optional service (Effect.serviceOption) exactly as today.
export type { Escalator }
export type { TurnAnswers }
