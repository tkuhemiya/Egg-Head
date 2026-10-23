/**
 * ClaimCheckRouter: the latest utterance -> which check to run, on what, for what claim.
 *
 * The research pipeline (research/decider, FINDINGS.md exp 4 and exp 9), in two requests:
 *
 * 1. The claim layers and the asserted state, on the latest line only.
 * 2. Only for a claim, on the latest line plus two turns: the resource, unless code found
 *    exactly one by alias (shortlist from aliases in the latest or the two turns before it,
 *    else every resource), and the check for each candidate, limited to that resource's checks.
 *
 * Research asked each option rotation as its own request, and six claim layers. Here
 * rotations share a batch (exp 8: within 0.002), only the four combo layers are asked, and
 * the asserted state is asked in two orders, because the hosted API takes one request at a
 * time per client and at most 8 questions per request. The route fires when check != none, resource != unknown and
 * min(claim, resource confidence, check confidence) >= T_ROUTE. Held-out: P 0.81 R 0.81.
 */
import { Context, Effect, Option, Schema } from "effect"
import { type AiError, Decision, DecisionModel } from "effect/ai"
import {
  ASSERTED,
  ASSERTED_INSTRUCTIONS,
  checkCriteria,
  checkInstructions,
  CLAIM_LAYERS,
  claimProbability,
  claimQuestions,
  NONE_CHECK,
  renderKv,
  RESOURCE_INSTRUCTIONS,
  reversals,
  rotatedChoice,
  type Turn,
  UNKNOWN_RESOURCE,
  UNKNOWN_RESOURCE_DESCRIPTION
} from "./Questions.ts"
import type { SupportError } from "./Speaker.ts"

/** Questions per request: the hosted API rejects more than 8 (422 too_long, 22 Oct 2026). */
export const MAX_BATCH = 8

export const T_CLAIM = 0.5
export const T_ROUTE = 0.25 // min of the three confidences (exp 9: 0.5 compounded into recall 0.56)

export const Route = Schema.Struct({
  action: Schema.Literals(["check", "escalate", "ignore"]),
  check: Schema.OptionFromNullOr(Schema.String),
  resource: Schema.OptionFromNullOr(Schema.String),
  asserted: Schema.OptionFromNullOr(Schema.String),
  /** claim, resource and check confidences, plus each raw claim layer, for the dashboard. */
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
 * Support for claims Decider could not route (a claim, but no confident check and resource):
 * a larger model picks the route from the transcript. Optional; without it an escalated
 * utterance is counted and dropped. This is the "cascade" FINDINGS.md suggests; untested.
 */
export class Escalator extends Context.Service<Escalator, {
  route(turns: ReadonlyArray<Turn>): Effect.Effect<Route, SupportError>
}>()("egghead/Router/Escalator") {}

// ---------------------------------------------------------------------------
// Pure parts
// ---------------------------------------------------------------------------

/** Resource aliases (research common.py ALIAS). Code settled the resource on a third of dev lines. */
export const ALIASES: Readonly<Record<string, ReadonlyArray<RegExp>>> = {
  "orders-db": [/orders[- ]?db/, /orders database/],
  "payments-db": [/payments[- ]?db/, /payments database/],
  "orders-api": [/orders[- ]?api/, /orders api/],
  "payments-api": [/payments[- ]?api/, /payments api/],
  "checkout-queue": [/checkout[- ]?queue/, /checkout queue/],
  "auth-service": [/\bauth\b/, /auth service/]
}

export const aliasHits = (text: string): Array<string> => {
  const s = text.toLowerCase()
  return Object.entries(ALIASES).filter(([, ps]) => ps.some((p) => p.test(s))).map(([r]) => r)
}

/** Candidate resources: aliases in the latest line, else in the two turns before it, else all. */
export const shortlist = (turns: ReadonlyArray<Turn>, resources: ReadonlyArray<string>): Array<string> => {
  const hits = aliasHits(turns[turns.length - 1]![1])
  if (hits.length > 0) return hits
  const recent = turns.slice(-3, -1).flatMap(([, t]) => aliasHits(t))
  return recent.length > 0 ? [...new Set(recent)] : [...resources]
}

export interface Pick {
  readonly label: string
  readonly confidence: number // (N·p_max − 1)/(N − 1), Decider's own scale
  readonly probabilities: Readonly<Record<string, number>>
}

/** Average the rotated answers of one choice and pick the top label (first on ties). */
export const average = (answers: ReadonlyArray<Decision.ClassifyAnswer<string>>): Pick => {
  const sum: Record<string, number> = {}
  for (const a of answers) {
    for (const [label, p] of Object.entries<number>(a.probabilities)) sum[label] = (sum[label] ?? 0) + p / answers.length
  }
  const labels = Object.keys(sum)
  const label = labels.reduce((best, l) => (sum[l]! > sum[best]! ? l : best))
  const n = labels.length
  return { label, confidence: n > 1 ? (n * sum[label]! - 1) / (n - 1) : 1, probabilities: sum }
}

export interface Signals {
  readonly claim: number
  readonly layers: Readonly<Record<string, number>>
  readonly asserted: string
  readonly resource: Option.Option<Pick>
  readonly check: Option.Option<Pick>
}

/** The route rule, in code. */
export const decide = (s: Signals): Route => {
  const scores: Record<string, number> = { claim: s.claim, ...prefixed("layer_", s.layers) }
  if (Option.isSome(s.resource)) scores.resource = s.resource.value.confidence
  if (Option.isSome(s.check)) scores.check = s.check.value.confidence
  const resource = Option.filter(Option.map(s.resource, (r) => r.label), (r) => r !== UNKNOWN_RESOURCE)
  const check = Option.filter(Option.map(s.check, (c) => c.label), (c) => c !== NONE_CHECK)
  const isClaim = s.claim >= T_CLAIM
  const lowest = Math.min(s.claim, scores.resource ?? 0, scores.check ?? 0)
  const fires = isClaim && Option.isSome(resource) && Option.isSome(check) && lowest >= T_ROUTE
  return {
    action: fires ? "check" : isClaim ? "escalate" : "ignore",
    check: fires ? check : Option.none(),
    resource: fires ? resource : Option.none(),
    asserted: Option.some(s.asserted),
    scores
  }
}

const prefixed = (prefix: string, r: Readonly<Record<string, number>>) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [`${prefix}${k}`, v]))

// ---------------------------------------------------------------------------
// Asking Decider
// ---------------------------------------------------------------------------

export interface Inventory {
  readonly resources: Readonly<Record<string, string>> // name -> description (option label)
  readonly checks: Readonly<Record<string, ReadonlyArray<string>>> // resource -> its checks, in order
}

/** Average the rotations asked under `${prefix}0`, `${prefix}1`, ... */
const averaged = (answers: Readonly<Record<string, unknown>>, prefix: string) =>
  average(
    Object.entries(answers).filter(([k]) => new RegExp(`^${prefix}\\d+$`).test(k)).map(([, a]) => a as Decision.ClassifyAnswer<string>)
  )

/** Ask Decider about the latest of `turns` and apply the route rule. */
export const route = Effect.fnUntraced(function*(turns: ReadonlyArray<Turn>, inventory: Inventory) {
  // 1. Claim layers and asserted state: latest line only.
  const stage1 = Decision.make({
    input: Schema.String,
    decisions: { ...claimQuestions.decisions, ...rotatedChoice("a", ASSERTED_INSTRUCTIONS, ASSERTED, reversals) }
  })
  const { answers } = yield* DecisionModel.decide(stage1, { input: renderKv(turns, 1) })
  const layers = Object.fromEntries(Object.keys(CLAIM_LAYERS).map((k) => [k, answers[k as keyof typeof CLAIM_LAYERS].probability]))
  const claim = claimProbability({
    short: answers.short.probability,
    fact: answers.fact.probability,
    status: answers.status.probability,
    hedge: answers.hedge.probability
  })
  const asserted = averaged(answers, "a").label
  if (claim < T_CLAIM) return decide({ claim, layers, asserted, resource: Option.none(), check: Option.none() })

  // 2. Only for a claim: the resource (unless code found it), then that resource's checks.
  // A candidate's checks ride along with the resource question while the batch stays small.
  const candidates = shortlist(turns, Object.keys(inventory.resources))
  const aliased = aliasHits(turns[turns.length - 1]![1]).length === 1
  const kv3 = renderKv(turns, 3)
  const checksOf = (r: string, i: number) => rotatedChoice(`c${i}_`, checkInstructions(r), checkCriteria(inventory.checks[r] ?? []))
  const checkable = candidates.filter((r) => (inventory.checks[r]?.length ?? 0) > 0)
  const resourceQuestions = aliased ? {} : rotatedChoice("r", RESOURCE_INSTRUCTIONS, {
    ...Object.fromEntries(candidates.map((r) => [r, inventory.resources[r] ?? r])),
    [UNKNOWN_RESOURCE]: UNKNOWN_RESOURCE_DESCRIPTION
  })
  const alongside = checkable.map(checksOf)
  const fits = Object.keys(resourceQuestions).length + alongside.reduce((n, q) => n + Object.keys(q).length, 0) <= MAX_BATCH
  const first = Object.assign({}, resourceQuestions, ...(fits ? alongside : [])) as Record<string, Decision.Classify<string>>
  const routed: Record<string, unknown> = Object.keys(first).length === 0
    ? {}
    : (yield* DecisionModel.decide(Decision.make({ input: Schema.String, decisions: first }), { input: kv3 })).answers
  const resource: Pick = aliased
    ? { label: candidates[0]!, confidence: 1, probabilities: { [candidates[0]!]: 1 } }
    : averaged(routed, "r")
  const i = checkable.indexOf(resource.label)
  if (i < 0) return decide({ claim, layers, asserted, resource: Option.some(resource), check: Option.none() })
  const checkAnswers = fits
    ? routed
    : (yield* DecisionModel.decide(Decision.make({ input: Schema.String, decisions: checksOf(resource.label, i) }), { input: kv3 })).answers
  return decide({ claim, layers, asserted, resource: Option.some(resource), check: Option.some(averaged(checkAnswers, `c${i}_`)) })
}) as (turns: ReadonlyArray<Turn>, inventory: Inventory) => Effect.Effect<Route, AiError.AiError, DecisionModel.DecisionModel>

