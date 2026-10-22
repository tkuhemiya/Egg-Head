/**
 * Decider questions and the state they read: the research pipeline (research/decider), frozen
 * on dev and scored once on held-out (FINDINGS.md, exp 9 and final_eval).
 *
 * - Claim: four narrow yes/no questions on the latest utterance alone (kv format, window 1),
 *   combined with a logistic fit on dev. Held-out claim F1 0.89.
 * - Routing: code finds the resource by alias; otherwise Decider picks from a shortlist (kv,
 *   window 3). Then Decider picks a check from that resource's own checks. Every choice is
 *   asked in all option rotations and averaged (exp 2: the top answer flips on 9-33%).
 * - Gate: "did someone already correct it?" and "has the speaker finished?" on the tagged
 *   transcript (window 6) with the silence and the flagged claim. "Finished" is Platt-scaled.
 *
 * Wording, formats, weights and Platt parameters are held to the Python research code by
 * test/Questions.test.ts (fixture from research/decider/scripts/export_runtime_parity.py).
 * Do not reword without re-running the research scripts: small changes move accuracy a lot.
 */
import { Schema } from "effect"
import { Decision } from "effect/ai"
import { CHECKS } from "./Checks.ts"

export type Turn = readonly [speaker: string, text: string]

export interface FlaggedClaim {
  readonly speaker: string
  readonly claim: string
  readonly evidence: string
}

const HEAD = "Live group call. The AI assistant on the call is named Egg Head."

/** Key-value state: the latest utterance plus up to `window - 1` turns before it. */
export const renderKv = (turns: ReadonlyArray<Turn>, window: number): string => {
  const shown = turns.slice(-window)
  const latest = shown[shown.length - 1]!
  const prev = shown.slice(0, -1).map(([s, t]) => `${s}: ${t}`).join(" | ") || "(none)"
  return `setting: live group call; AI assistant name: Egg Head\nprevious_turns: ${prev}\n` +
    `latest_speaker: ${latest[0]}\nlatest_utterance: ${latest[1]}`
}

/** Tagged transcript for the gate questions: last 6 turns, silence, and the flagged claims. */
export const renderGate = (turns: ReadonlyArray<Turn>, silenceS: number, flagged: ReadonlyArray<FlaggedClaim>): string => {
  const shown = turns.slice(-6)
  const lines = [HEAD, "Transcript (oldest first):"]
  shown.forEach(([s, t], i) => lines.push(`${i === shown.length - 1 ? "LATEST >>> " : ""}${s}: ${t}`))
  let state = lines.join("\n") + `\nSilence since the latest speaker stopped: ${silenceS.toFixed(1)} s`
  if (flagged.length > 0) {
    state += "\nFlagged claim (checked by Egg Head, not yet raised): " +
      flagged.map((f) => `${f.speaker} said "${f.claim}"; live check shows ${f.evidence}`).join("; ")
  }
  return state
}

// ---------------------------------------------------------------------------
// Claim: four yes/no layers, one batch (exp 9)
// ---------------------------------------------------------------------------

/** The four exp 9 layers the combo uses (exp 9 also asked `repo` and `names` in the same batch). */
export const CLAIM_LAYERS = {
  short: "Does the latest speaker state a fact about the current state of a computer system or service?",
  fact: "Is the latest speaker saying how something is right now, as a fact rather than a guess, plan or question?",
  status: "Does the latest utterance report a status, number or observation, such as fine, down, slow, errors, " +
    "CPU, or a deploy?",
  hedge: "Is the latest speaker unsure, guessing, asking, or saying what they will do, rather than stating what is true now?"
} as const

// Logistic combo short+fact+status-hedge, fit on all dev (results/exp9_weights_dev.json).
export const CLAIM_WEIGHTS = {
  short: 1.6585223350606675,
  fact: 1.0077377702754509,
  status: 1.2263776340754051,
  hedge: -0.6547312851005924
} as const
const CLAIM_BIAS = -1.3042172764678281

const logit = (p: number) => {
  const q = Math.min(Math.max(p, 1e-4), 1 - 1e-4)
  return Math.log(q / (1 - q))
}
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))

export const claimQuestions = Decision.make({
  input: Schema.String,
  decisions: Object.fromEntries(
    Object.entries(CLAIM_LAYERS).map(([k, instructions]) => [k, Decision.probability({ instructions })])
  ) as { [K in keyof typeof CLAIM_LAYERS]: Decision.Probability }
})
export type ClaimAnswers = Decision.Answers<typeof claimQuestions.decisions>

/** P(the latest utterance is a claim about a system's current state). */
export const claimProbability = (layers: Readonly<Record<keyof typeof CLAIM_WEIGHTS, number>>): number =>
  sigmoid(CLAIM_BIAS + Object.entries(CLAIM_WEIGHTS).reduce((z, [k, w]) => z + w * logit(layers[k as keyof typeof CLAIM_WEIGHTS]), 0))

// ---------------------------------------------------------------------------
// What the claim asserts (compared with the check result in code)
// ---------------------------------------------------------------------------

export const ASSERTED = {
  healthy: "The speaker says it is fine, normal, working or not the problem",
  degraded: "The speaker says it is slow, erroring, elevated, backed up or struggling",
  down: "The speaker says it is completely down or unreachable",
  changed: "The speaker says something was deployed, released or changed",
  unchanged: "The speaker says nothing was deployed, released or changed",
  unclear: "The speaker does not say what state it is in"
} as const

export const ASSERTED_INSTRUCTIONS = "What does the latest speaker claim about that resource?"

// ---------------------------------------------------------------------------
// Routing: resource, then a check limited to that resource (final_eval, exp 4 R4)
// ---------------------------------------------------------------------------

export const RESOURCE_INSTRUCTIONS =
  "Which single named resource is the latest utterance about? Use earlier turns to resolve words like 'it' or 'the database'."
export const UNKNOWN_RESOURCE = "unknown"
export const UNKNOWN_RESOURCE_DESCRIPTION = "unknown: unclear which single resource, or several, or none"

export const checkInstructions = (resource: string) => `Which check would verify what the latest utterance says about ${resource}?`
export const NONE_CHECK = "none"
export const NONE_CHECK_DESCRIPTION = "None of these checks can verify it"

export const checkCriteria = (checks: ReadonlyArray<string>): Record<string, string> => ({
  ...Object.fromEntries(checks.map((c) => [c, CHECKS[c as keyof typeof CHECKS] ?? c])),
  [NONE_CHECK]: NONE_CHECK_DESCRIPTION
})

/** The option order forward and reversed (exp 2: two orders got most of the gain of all rotations). */
export const reversals = (criteria: Readonly<Record<string, string>>): Array<Record<string, string>> => {
  const keys = Object.keys(criteria)
  return [keys, [...keys].reverse()].map((ks) => Object.fromEntries(ks.map((key) => [key, criteria[key]!])))
}

/** Every rotation of the option order: [a, b, c], [b, c, a], [c, a, b]. */
export const rotations = (criteria: Readonly<Record<string, string>>): Array<Record<string, string>> => {
  const keys = Object.keys(criteria)
  return keys.map((_, k) => Object.fromEntries([...keys.slice(k), ...keys.slice(0, k)].map((key) => [key, criteria[key]!])))
}

/** The same choice asked in every option order (or `orders`), keyed `${prefix}${k}`. */
export const rotatedChoice = (
  prefix: string,
  instructions: string,
  criteria: Readonly<Record<string, string>>,
  orders = rotations
) => Object.fromEntries(orders(criteria).map((c, k) => [`${prefix}${k}`, Decision.classify<string>({ instructions, criteria: c })]))

// ---------------------------------------------------------------------------
// Gate (final_eval speak gate)
// ---------------------------------------------------------------------------

export const SELF_REPAIRED =
  "After the flagged claim, did someone on the call already say it was wrong, or question whether it was right? " +
  "Agreeing with it is not a correction."
export const FINISHED = "Has the latest speaker finished their turn, so that someone else could start talking now?"

export const gateQuestions = Decision.make({
  input: Schema.String,
  decisions: {
    rep: Decision.probability({ instructions: SELF_REPAIRED }),
    fin: Decision.probability({ instructions: FINISHED })
  }
})

// Platt scaling for `fin`, fit on dev (results/exp6_platt_dev.json). Raw "finished" sat below
// 0.5 on every line (F1 0.00 at 0.5); after scaling F1 was 0.96.
const PLATT_FIN = [1.4123838956777892, 3.406872326963613] as const

export const finishedProbability = (raw: number): number => sigmoid(PLATT_FIN[0] * logit(raw) + PLATT_FIN[1])
