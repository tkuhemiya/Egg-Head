/** Claim vs check result, in code: supports / contradicts / inconclusive. */

export type Verdict = "supports" | "contradicts" | "inconclusive"

const BAD = new Set(["degraded", "down"])

export const compare = (asserted: string | null | undefined, status: string | null | undefined): Verdict => {
  if (asserted == null || asserted === "unclear" || status == null) return "inconclusive"
  if (asserted === "healthy") return BAD.has(status) ? "contradicts" : "supports"
  if (BAD.has(asserted)) return status === "healthy" ? "contradicts" : "supports"
  if (asserted === "changed" || asserted === "unchanged") {
    if (status !== "changed" && status !== "unchanged") return "inconclusive"
    return asserted === status ? "supports" : "contradicts"
  }
  return "inconclusive"
}

// Decider answered `unclear` on 10 of 25 pass-2 asserted_state cases, so when it does, fall
// back to the plain wording of the utterance. Order matters: "didn't deploy" before "deploy".
const FALLBACK: ReadonlyArray<readonly [string, RegExp]> = [
  ["unchanged", /\b(?:didn'?t|did not|haven'?t|have not|no|nothing)\b.*\b(?:deploy|release|chang)/i],
  ["changed", /\b(?:deployed|released|rolled out|pushed|changed)\b/i],
  ["healthy", /\b(?:fine|normal|healthy|green|ok(?:ay)?|stable|not the problem|no alarms)\b/i],
  ["down", /\b(?:completely down|is down|unreachable)\b/i],
  ["degraded", /\b(?:slow|spik\w+|erroring|elevated|backed up|struggling|high)\b/i]
]

export const inferAsserted = (text: string): string =>
  FALLBACK.find(([, pattern]) => pattern.test(text))?.[0] ?? "unclear"
