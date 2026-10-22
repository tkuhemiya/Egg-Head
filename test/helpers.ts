/**
 * A scripted Decider for tests: answers each request from what is said in its latest
 * utterance, in the wire format of a real /v1/systemone response.
 */
import { Effect } from "effect"
import { AiError } from "effect/ai"
import type { SystemOneAnswer, SystemOneRequest } from "../src/Decider.ts"
import { ScriptedDecider } from "../src/Decider.ts"
import { NONE_CHECK, UNKNOWN_RESOURCE } from "../src/Questions.ts"

/** What Decider "thinks" about one utterance. Defaults: not a claim, nothing repaired, finished. */
export interface Line {
  readonly claim?: number // every claim layer says this (hedge says 1 - claim)
  readonly asserted?: string
  readonly resource?: string
  readonly check?: string
  readonly rep?: number // gate: P(someone already corrected the flagged claim)
  readonly fin?: number // gate: raw P(the speaker has finished), before Platt scaling
  readonly p?: number // probability on the scripted label of every choice
  readonly addr?: number // turn: P(talking to Egg Head)
  readonly ask?: number // turn: P(a question to the call)
  readonly act?: number // partial: P(telling someone to act on a system now)
}

export const noul = (p: number): SystemOneAnswer => ({ type: "noul", noul: p })

/** A full distribution over `labels`: `p` on `label`, the rest spread evenly. */
export const choiceOver = (labels: ReadonlyArray<string>, label: string, p = 0.9): SystemOneAnswer => {
  if (!labels.includes(label)) throw new Error(`scripted label ${label} is not an option: ${labels.join(", ")}`)
  const rest = (1 - p) / (labels.length - 1)
  const n = labels.length
  return {
    type: "choice",
    choice: label,
    probabilities: Object.fromEntries(labels.map((l) => [l, l === label ? p : rest])),
    confidence: (n * p - 1) / (n - 1)
  }
}

/** The latest utterance in a kv state (`latest_utterance:`) or a gate state (`LATEST >>> name:`). */
export const latestOf = (state: unknown): string => {
  const s = String(state)
  const kv = /^latest_utterance: (.*)$/m.exec(s)
  if (kv) return kv[1]!
  const tagged = /^LATEST >>> [^:]+: (.*)$/m.exec(s)
  if (tagged) return tagged[1]!
  throw new Error(`no latest utterance in state:\n${s}`)
}

export const answerLine = (request: SystemOneRequest, line: Line): Record<string, SystemOneAnswer> => {
  const claim = line.claim ?? 0.05
  return Object.fromEntries(Object.entries(request.questions).map(([key, q]) => {
    const labels = q.type === "choice" ? Object.keys(q.criteria) : []
    if (key === "rep") return [key, noul(line.rep ?? 0.1)]
    if (key === "fin") return [key, noul(line.fin ?? 0.5)]
    if (key === "addr") return [key, noul(line.addr ?? 0.05)]
    if (key === "ask") return [key, noul(line.ask ?? 0.05)]
    if (key === "act") return [key, noul(line.act ?? 0.05)]
    switch (/^([arc])[\d_]+$/.exec(key)?.[1]) {
      case "a":
        return [key, choiceOver(labels, line.asserted ?? "unclear", line.p)]
      case "r":
        return [key, choiceOver(labels, line.resource ?? UNKNOWN_RESOURCE, line.p)]
      case "c": // every candidate resource's checks are asked; the scripted check is on one of them
        return [key, choiceOver(labels, labels.includes(line.check ?? "") ? line.check! : NONE_CHECK, line.p)]
    }
    return [key, noul(key === "hedge" ? 1 - claim : claim)]
  }))
}

/** Answers by the text of the latest utterance; unscripted lines are "not a claim". */
export const scripted = (lines: Readonly<Record<string, Line>>) =>
  ScriptedDecider.layerWith((request) => {
    try {
      return Effect.succeed(answerLine(request, lines[latestOf(request.state)] ?? {}))
    } catch (e) {
      return Effect.fail(AiError.make({
        module: "test",
        method: "scripted",
        reason: new AiError.InvalidOutputError({ description: String(e) })
      }))
    }
  })

/** Raw `fin` whose Platt-scaled value is `1 - interruptP` (to replay a recorded interrupt probability). */
export const finFor = (interruptP: number): number => {
  const [a, b] = [1.4123838956777892, 3.406872326963613]
  const target = Math.min(Math.max(1 - interruptP, 1e-9), 1 - 1e-9)
  const z = (Math.log(target / (1 - target)) - b) / a
  return 1 / (1 + Math.exp(-z))
}
