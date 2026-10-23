/**
 * Conversation (delta): Decider questions, the reply-timing rule and the spoken lines stay;
 * Request moves to Requests.ts. The lines are now chosen from a Policy plan, so wording follows
 * certainty and basis in one place:
 *
 *   flag,  firm,      confirmed   "Quick flag, Sam: orders-db is degraded, CPU 98%."
 *   flag,  tentative, fastCheck   "Quick flag, Sam: my quick check shows orders-db degraded, CPU 98%. I couldn't confirm it further."
 *   flag,  (no Investigator)      Writer.write(claim) as today (template or Bedrock): parity
 *   barge, firm                   "Sorry to cut in, Priya: payments-api is healthy, 5xx 0.1%."
 *   barge, tentative              "Sorry to cut in, Priya: my quick check shows payments-api healthy. I'm double-checking."
 *   update (overruled)            "Update on payments-api: it's actually degraded. Ignore my cut-in."
 *   update (unsettled)            "Update on payments-api: I couldn't confirm what I said. Treat it as unchecked."
 *   ack / take                    "On it, Priya." / "I can check that."
 *   answer, Answered              "Priya, the checkout queue has 12,400 messages."
 *   answer, Unknown               "Priya, I couldn't find that out."
 */
import type { Claim } from "./Claims.ts"
import type { Certainty } from "./Event.ts"
import type { AnswerResult } from "./Investigator.ts"

export interface ReplyTuning {
  readonly finished: number
  readonly replyMaxWaitS: number
}

export const flagLine = (c: Claim, certainty: Certainty, fact: string): string => {
  throw new Error("not implemented")
}
export const bargeLine = (toward: string, c: Claim, certainty: Certainty, fact: string): string => {
  throw new Error("not implemented")
}
export const updateLine = (c: Claim, why: "overruled" | "unsettled", fact: string): string => {
  throw new Error("not implemented")
}
export const answerLine = (speaker: string, answer: AnswerResult): string => {
  throw new Error("not implemented")
}
/** The agent's spoken fact, clamped (review "Noted": no length clamp). */
export const clampFact = (fact: string, maxWords?: number): string => {
  throw new Error("not implemented")
}
