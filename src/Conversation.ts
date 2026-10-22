/**
 * Conversation: when Egg Head is spoken to, when the call leaves a question hanging, and when
 * someone is about to act on a claim Egg Head knows is wrong.
 *
 * Same split as the rest of Egg Head: Decider answers yes/no questions, code holds the rules.
 *
 * - Spoken to: Egg Head is named (code) and Decider says the speaker is asking it for something.
 *   It replies only once Decider says the speaker has finished (the gate's Platt-scaled
 *   `finished`), so "Egg Head, can you check the, uh..." followed by a pause gets nothing yet.
 *   A trailing filler or dangling word also counts as unfinished (code), and after
 *   REPLY_MAX_WAIT_S of silence it replies anyway.
 * - A question to the call (Decider) that nobody answers within OPEN_SILENCE_S is Egg Head's.
 *   Anyone else speaking first takes it.
 * - Barge-in: a live partial transcript names a resource with an open contradicted claim
 *   (code), and Decider says the speaker is telling someone to act on a system now. Waiting for
 *   a gap would cost more than interrupting, so this skips the gate's silence rules.
 *
 * These questions have no research numbers behind them yet (research/decider scored claim
 * routing and the gate); their wording follows the research findings (separate yes/no
 * questions, the latest line, plain words).
 */
import { Schema } from "effect"
import { Decision } from "effect/ai"
import { FINISHED, SELF_REPAIRED } from "./Questions.ts"

export const ADDRESSED =
  "Is the latest speaker talking to Egg Head, the AI assistant, and asking it to check, answer or do something?"
export const ASKS =
  "Is the latest speaker asking the people on the call a question about the current state of a system, service, " +
  "metric or recent deploy?"
export const DIRECTIVE =
  "Is the latest speaker telling someone to take an action on a system right now, such as restart, roll back, " +
  "scale up or fail over?"

/** The gate questions plus the two turn questions, on the gate's tagged transcript: one request. */
export const turnQuestions = Decision.make({
  input: Schema.String,
  decisions: {
    rep: Decision.probability({ instructions: SELF_REPAIRED }),
    fin: Decision.probability({ instructions: FINISHED }),
    addr: Decision.probability({ instructions: ADDRESSED }),
    ask: Decision.probability({ instructions: ASKS })
  }
})

export type TurnAnswers = Decision.Answers<typeof turnQuestions.decisions>

/** Asked on a live partial transcript (kv state, latest line), only after the code filter. */
export const directiveQuestions = Decision.make({
  input: Schema.String,
  decisions: { act: Decision.probability({ instructions: DIRECTIVE }) }
})

// Uncalibrated. Decider's raw yes/no probabilities run low (raw `finished` sat below 0.5 on every
// research line before Platt scaling), and each of these already passed a code check (Egg Head
// named, a "?", a resource with a wrong claim), so Decider only has to not say no.
export const T_ADDRESSED = 0.25
export const T_ASKS = 0.3
export const T_FINISHED = 0.5 // Platt-scaled (research exp 6)
export const T_DIRECTIVE = 0.3
export const REPLY_MAX_WAIT_S = 4.0
export const OPEN_SILENCE_S = 2.5

const NAME = /\begg[ -]?head\b/i
const TRAILING = /(?:\b(?:uh|um|er|erm|so|the|a|an|and|or|of|to|for|on|in|with|like)|[,…-]|\.\.\.)\s*$/i

export const namesEggHead = (text: string): boolean => NAME.test(text)

/** The words stop mid-thought ("can you check the, uh..."), whatever the model says. */
export const trailsOff = (text: string): boolean => TRAILING.test(text.trim())

export const isQuestion = (text: string): boolean => text.includes("?")

export const RequestKind = Schema.Literals(["addressed", "open"])
export const RequestState = Schema.Literals(["listening", "checking", "ready", "answered", "dropped"])

/** Something asked of Egg Head (or of the call, and left unanswered). */
export const Request = Schema.Struct({
  id: Schema.Int,
  kind: RequestKind,
  speaker: Schema.String,
  text: Schema.String,
  turn: Schema.Int, // first turn of the question
  state: RequestState,
  answer: Schema.OptionFromNullOr(Schema.String),
  note: Schema.String // why it is in this state, for the dashboard
})
export type Request = typeof Request.Type

export interface ReplyInput {
  readonly finishedP: number // Platt-scaled
  readonly text: string
  readonly silenceS: number
}

/** Has the person speaking to Egg Head finished, so it can reply? */
export const readyToReply = (r: ReplyInput): { readonly ready: boolean; readonly why: string } => {
  if (r.silenceS >= REPLY_MAX_WAIT_S) return { ready: true, why: `${r.silenceS.toFixed(1)} s of silence` }
  if (trailsOff(r.text)) return { ready: false, why: "trails off mid-sentence" }
  if (r.finishedP < T_FINISHED) return { ready: false, why: `Decider: not finished (${r.finishedP.toFixed(2)})` }
  return { ready: true, why: `Decider: finished (${r.finishedP.toFixed(2)})` }
}

/** A checked claim's evidence as one spoken fact, when no model wrote one. */
export const factOf = (item: { readonly resource: string; readonly status: string; readonly evidence: string }): string =>
  `${item.resource} is ${item.status}, ${item.evidence}`

/** Short spoken lines, written in code (the instant ones cannot wait for a model). */
export const ackLine = (speaker: string): string => `On it, ${speaker}.`
export const OPEN_ACK = "I can check that."
export const bargeLine = (speaker: string, fact: string): string => `Sorry to cut in, ${speaker}: ${sentence(fact)}`
export const flagLine = (speaker: string, fact: string): string => `Quick flag, ${speaker}: ${sentence(fact)}`
export const answerLine = (speaker: string, answer: string): string =>
  answer.toLowerCase().startsWith(speaker.toLowerCase()) ? sentence(answer) : `${speaker}, ${sentence(lowerFirst(answer))}`

const sentence = (s: string) => {
  const t = s.trim().replace(/\s+/g, " ")
  return /[.!?]$/.test(t) ? t : `${t}.`
}
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s)
