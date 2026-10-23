/**
 * Investigator (delta). The second look and the answer, now with "could not tell".
 *
 * - `Finding.Unknown`: the agent ran and no data settled the claim. Egg Head stays quiet about
 *   it (Claims: Closed{unsettled}, dashboard note), or, if it already barged tentatively,
 *   says an update ("I couldn't confirm that, sorry to cut in").
 * - `AnswerResult.Unknown`: nothing answered the question. Egg Head still answers the asker:
 *   "Lee, I couldn't find that out." (Requests: Ready{Unknown}).
 * - A failure (error, or the Bridge's deadline) is not Unknown: for a claim it triggers the
 *   fast re-run (job kind `recheck`, owner decision 2); for a question it becomes Unknown.
 *
 * The Investigator no longer receives a task number: the Bridge's JobId is for the dashboard
 * and the AgentTerminal numbers its own jobs (commit b629bba). It receives a ClaimView, not a
 * Ledger row, so the agent's prompt does not depend on Bridge internals.
 */
import { Context, Effect, Layer, Schema } from "effect"
import { CheckSource, Status } from "./Checks.ts"
import { SupportError } from "./Speaker.ts"

export const Finding = Schema.Union([
  Schema.TaggedStruct("Found", { status: Status, fact: Schema.String }),
  Schema.TaggedStruct("Unknown", { why: Schema.String })
])
export type Finding = typeof Finding.Type

export const AnswerResult = Schema.Union([
  Schema.TaggedStruct("Answered", { text: Schema.String }),
  Schema.TaggedStruct("Unknown", { why: Schema.String })
])
export type AnswerResult = typeof AnswerResult.Type

export interface ClaimView {
  readonly speaker: string
  readonly text: string
  readonly check: string
  readonly resource: string
  readonly fastStatus: Status
}

export interface Question {
  readonly speaker: string
  readonly text: string
  readonly addressed: boolean
}

export class Investigator extends Context.Service<Investigator, {
  readonly name: string
  confirm(claim: ClaimView): Effect.Effect<Finding, SupportError>
  answer(question: Question): Effect.Effect<AnswerResult, SupportError>
}>()("egghead/Investigator") {
  static readonly direct: Layer.Layer<Investigator, never, CheckSource> = Layer.effect(Investigator, Effect.map(CheckSource.asEffect(), direct))
}

/**
 * No model. confirm: re-run the claim's check (no result -> Unknown). answer: the check the
 * question's words point at (no resource named -> Unknown, never a failure: finding 2's root).
 * Also the `recheck` job's implementation, whatever Investigator is wired.
 */
export const direct = (source: CheckSource["Service"]): Investigator["Service"] => {
  throw new Error("not implemented")
}

// demo/Agent.ts: `egghead report N --unknown "<why>"` and `egghead answer N --unknown "<why>"`
// join the Report schema; confirmPrompt/answerPrompt say when to use them ("no data settles it").
