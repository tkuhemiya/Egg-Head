/** ClaimCheckRouter: Decider routing answers -> which check to run, on what, for what claim. */
import { Context, type Effect, Option, Schema } from "effect"
import type { ClassifyAnswer } from "effect/ai/Decision"
import { NONE_CHECK, UNKNOWN_RESOURCE } from "./Checks.ts"
import type { RoutingAnswers, Turn } from "./Questions.ts"
import type { SupportError } from "./Speaker.ts"

export const T_ROUTE = 0.7 // fire the check at or above this (100% precision on pass 2)
export const T_ESCALATE = 0.55 // between this and T_ROUTE, hand the decision to Bedrock (counted)

export const Route = Schema.Struct({
  action: Schema.Literals(["check", "escalate", "ignore"]),
  check: Schema.OptionFromNullOr(Schema.String),
  resource: Schema.OptionFromNullOr(Schema.String),
  asserted: Schema.OptionFromNullOr(Schema.String),
  scores: Schema.Record(Schema.String, Schema.Number)
})
export type Route = typeof Route.Type

export const ignore: Route = {
  action: "ignore",
  check: Option.none(),
  resource: Option.none(),
  asserted: Option.none(),
  scores: {}
}

/**
 * Decider reports choice confidence as (N·p_max − 1)/(N − 1), so one threshold works for
 * any number of options. Recompute it the same way if a provider leaves it out.
 */
export const confidence = (answer: ClassifyAnswer<string>): number => {
  if (answer.confidence !== undefined) return answer.confidence
  const ps = Object.values<number>(answer.probabilities)
  return ps.length < 2 ? 1 : (ps.length * Math.max(...ps) - 1) / (ps.length - 1)
}

/**
 * Support for the mid-confidence band (T_ESCALATE to T_ROUTE): picks the route for the
 * latest utterance. Optional; without it an escalated utterance is counted and dropped.
 */
export class Escalator extends Context.Service<Escalator, {
  route(turns: ReadonlyArray<Turn>): Effect.Effect<Route, SupportError>
}>()("egghead/Router/Escalator") {}

export const route = (answers: RoutingAnswers): Route => {
  const scores = {
    is_claim: answers.is_claim.probability,
    which_check: confidence(answers.which_check),
    which_resource: confidence(answers.which_resource)
  }
  const check = answers.which_check.label
  const resource = answers.which_resource.label
  const asserted = answers.asserted_state.label
  const resolvable = check !== NONE_CHECK && resource !== UNKNOWN_RESOURCE
  const lowest = Math.min(...Object.values(scores))
  const action = resolvable && lowest >= T_ROUTE ? "check" : resolvable && lowest >= T_ESCALATE ? "escalate" : "ignore"
  return {
    action,
    check: resolvable ? Option.some(check) : Option.none(),
    resource: resolvable ? Option.some(resource) : Option.none(),
    asserted: Option.some(asserted),
    scores
  }
}
