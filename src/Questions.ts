/**
 * Decider questions (pass-2 wording from the spike) and the state they read.
 *
 * Routing questions apply only to the LATEST utterance. Policy questions read the flagged
 * claim from the ledger. Do not reword without re-running spike/run.py: pass 1 showed small
 * wording changes move accuracy a lot.
 */
import { Schema } from "effect"
import { Decision } from "effect/ai"
import { CHECKS, NONE_CHECK, NONE_DESCRIPTION, UNKNOWN_DESCRIPTION, UNKNOWN_RESOURCE } from "./Checks.ts"
import type { LedgerItem } from "./Ledger.ts"

export const ASSERTED = {
  healthy: "The speaker says it is fine, normal, working or not the problem",
  degraded: "The speaker says it is slow, erroring, elevated, backed up or struggling",
  down: "The speaker says it is completely down or unreachable",
  changed: "The speaker says something was deployed, released or changed",
  unchanged: "The speaker says nothing was deployed, released or changed",
  unclear: "The speaker does not say what state it is in"
} as const

export const ROUTING = ["is_claim", "which_check", "which_resource", "asserted_state"] as const
export const POLICY = ["self_repaired", "open_question", "floor_free"] as const

export type Turn = readonly [speaker: string, text: string]

export const renderState = (turns: ReadonlyArray<Turn>, openItems: ReadonlyArray<LedgerItem>): string => {
  const lines = [
    "Incident bridge call transcript (oldest first).",
    "Routing questions (is_claim, which_check, which_resource, asserted_state) " +
    "apply ONLY to the utterance marked LATEST, not to the flagged claim."
  ]
  turns.forEach(([speaker, text], i) => {
    const mark = i === turns.length - 1 ? ">>> LATEST " : ""
    lines.push(`${mark}${speaker}: ${text}`)
  })
  lines.push("")
  if (openItems.length > 0) {
    lines.push(
      "Flagged claim (already checked by Egg Head, not yet raised on the call). " +
        "Use this only for self_repaired, open_question, floor_free:"
    )
    for (const it of openItems) {
      lines.push(`- ${it.speaker} said "${it.claim}". Check ${it.check} on ${it.resource}: ${it.evidence}.`)
    }
  } else {
    lines.push("Flagged claim: none.")
  }
  return lines.join("\n")
}

const routingDecisions = (resources: Readonly<Record<string, string>>) => ({
  is_claim: Decision.probability({
    instructions: "Is the LATEST utterance a factual statement about how a system is " +
      "behaving right now, or about a recent deploy or change? Guesses, questions, plans, " +
      "actions, and statements about the past are not. Ignore the flagged claim."
  }),
  which_check: Decision.classify<string>({
    instructions: "Which one check would verify the LATEST utterance? If that utterance " +
      "is not a checkable claim, choose none. Ignore the flagged claim.",
    criteria: { ...CHECKS, [NONE_CHECK]: NONE_DESCRIPTION }
  }),
  which_resource: Decision.classify<string>({
    instructions: "Which single named resource does the LATEST utterance refer to? " +
      "Use earlier turns to resolve words like 'it' or 'the database'. If it is unclear, " +
      "several, or none, choose unknown. Ignore the flagged claim.",
    criteria: { ...resources, [UNKNOWN_RESOURCE]: UNKNOWN_DESCRIPTION }
  }),
  asserted_state: Decision.classify<string>({
    instructions: "What does the speaker of the LATEST utterance claim about that resource? Ignore the flagged claim.",
    criteria: ASSERTED
  })
})

const policyDecisions = {
  self_repaired: Decision.probability({
    instructions: "After the flagged claim, did someone on the call already say it " +
      "was wrong, or ask whether it was right? Agreeing with the claim is not a correction."
  }),
  open_question: Decision.probability({
    instructions: "Did someone ask a question in the recent conversation that is still waiting for an answer?"
  }),
  // Asked as the interrupt question (87% after inverting). Callers invert it.
  floor_free: Decision.probability({
    instructions: "Would speaking right now interrupt someone in the middle of a sentence or an argument?"
  })
}

type RoutingDecisions = ReturnType<typeof routingDecisions>
type PolicyDecisions = typeof policyDecisions
export type RoutingAnswers = Decision.Answers<RoutingDecisions>
export type PolicyAnswers = Decision.Answers<PolicyDecisions>
export type BridgeAnswers = RoutingAnswers & Partial<PolicyAnswers>

/** One Decider batch per utterance: routing always, policy only while a claim is open. */
export const buildQuestions = (resources: Readonly<Record<string, string>>, withPolicy: boolean) =>
  Decision.make({
    input: Schema.String,
    decisions: withPolicy ? { ...routingDecisions(resources), ...policyDecisions } : routingDecisions(resources)
  }) as Decision.Definition<typeof Schema.String, RoutingDecisions & Partial<PolicyDecisions>>
