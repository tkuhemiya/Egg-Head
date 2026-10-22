/** Decider answer builders for tests (wire format, like a real /v1/systemone response). */
import worldJson from "../data/world.json" with { type: "json" }
import { CHECKS, NONE_CHECK, UNKNOWN_RESOURCE } from "../src/Checks.ts"
import type { SystemOneAnswer } from "../src/Decider.ts"
import { ASSERTED } from "../src/Questions.ts"

export const LABELS = {
  which_check: [...Object.keys(CHECKS), NONE_CHECK],
  which_resource: [...Object.keys(worldJson.resources), UNKNOWN_RESOURCE],
  asserted_state: Object.keys(ASSERTED)
} as const

type ChoiceQuestion = keyof typeof LABELS

/** A choice answer with a full distribution: `p` on `name`, the rest spread evenly. */
export const choice = (q: ChoiceQuestion, name: string, p = 0.9, confidence?: number): SystemOneAnswer => {
  const labels = LABELS[q]
  const rest = (1 - p) / (labels.length - 1)
  const n = labels.length
  return {
    type: "choice",
    choice: name,
    probabilities: Object.fromEntries(labels.map((l) => [l, l === name ? p : rest])),
    confidence: confidence ?? (n * p - 1) / (n - 1)
  }
}

export const noul = (p: number): SystemOneAnswer => ({ type: "noul", noul: p })

export const routed = (check: string, resource: string, state: string, isClaim = 0.85) => ({
  is_claim: noul(isClaim),
  which_check: choice("which_check", check),
  which_resource: choice("which_resource", resource),
  asserted_state: choice("asserted_state", state)
})

export const ignored = () => routed("none", "unknown", "unclear", 0.1)

export const policy = (repaired = 0.2, interrupt = 0.2) => ({
  self_repaired: noul(repaired),
  open_question: noul(0.1),
  floor_free: noul(interrupt)
})
