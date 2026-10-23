/**
 * Hints: what a scripted Decider answers on one utterance, in the wire format of a real
 * /v1/systemone response. Offline scenarios and `--rehearsal` use it; real runs ask Decider.
 * (Moved here from test/helpers.ts, which re-exports it, so demo/ does not import test code.)
 *
 * A Schema, so a typo in a call script's `decider` block fails at decode instead of silently
 * meaning "not a claim".
 */
import { Effect, Option, Schema } from "effect"
import { AiError } from "effect/ai"
import { CHECKS, Status } from "../domain/Checks.ts"
import { type SystemOneAnswer, type SystemOneRequest, ScriptedDecider } from "./Decider.ts"
import { NONE_CHECK, UNKNOWN_RESOURCE } from "../domain/Questions.ts"

const P = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

/** Defaults: not a claim, nothing repaired, finished, not addressed, not a question, not a directive. */
export const Hints = Schema.Struct({
  claim: Schema.optionalKey(P), // every claim layer says this (hedge says 1 - claim)
  asserted: Schema.optionalKey(Schema.Union([Status, Schema.Literal("unclear")])),
  resource: Schema.optionalKey(Schema.String),
  check: Schema.optionalKey(Schema.Literals(Object.keys(CHECKS) as Array<keyof typeof CHECKS>)),
  rep: Schema.optionalKey(P), // gate: P(someone already corrected the flagged claim)
  fin: Schema.optionalKey(P), // gate: raw P(the speaker has finished), before Platt scaling
  p: Schema.optionalKey(P), // probability on the scripted label of every choice
  addr: Schema.optionalKey(P), // turn: P(talking to Egg Head)
  ask: Schema.optionalKey(P), // turn: P(a question to the call)
  act: Schema.optionalKey(P) // partial: P(telling someone to act on a system now)
})
export type Hints = typeof Hints.Type

/** Loose version for tests that script lines in TypeScript (and the parity replay's recorded labels). */
export interface Line {
  readonly claim?: number
  readonly asserted?: string
  readonly resource?: string
  readonly check?: string
  readonly rep?: number
  readonly fin?: number
  readonly p?: number
  readonly addr?: number
  readonly ask?: number
  readonly act?: number
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

const invalid = (e: unknown) =>
  AiError.make({ module: "test", method: "scripted", reason: new AiError.InvalidOutputError({ description: String(e) }) })

/** Answers by the exact text of the latest utterance; unscripted lines are "not a claim". */
export const scripted = (lines: Readonly<Record<string, Line>>) =>
  ScriptedDecider.layerWith((request) => {
    try {
      return Effect.succeed(answerLine(request, lines[latestOf(request.state)] ?? {}))
    } catch (e) {
      return Effect.fail(invalid(e))
    }
  })

/** Raw `fin` whose Platt-scaled value is `1 - interruptP` (to replay a recorded interrupt probability). */
export const finFor = (interruptP: number): number => {
  const [a, b] = [1.4123838956777892, 3.406872326963613]
  const target = Math.min(Math.max(1 - interruptP, 1e-9), 1 - 1e-9)
  const z = (Math.log(target / (1 - target)) - b) / a
  return 1 / (1 + Math.exp(-z))
}

/**
 * The hints of the line an utterance belongs to: its exact text, or (a partial transcript, or
 * a line cut off with "—") the line it is the start of. None for the warm-up request.
 */
export const hintsFor = (lines: ReadonlyArray<{ readonly text: string; readonly decider?: Line }>, state: unknown): Option.Option<Line> => {
  let latest: string
  try {
    latest = latestOf(state)
  } catch {
    return Option.none()
  }
  const start = latest.replace(/—$/, "")
  const line = lines.find((l) => l.text === latest) ??
    lines.find((l) => start.length > 3 && l.text.startsWith(start))
  return Option.some(line?.decider ?? {})
}

/**
 * A call's scripted Decider: each line's hints, `latencyMs` per batch on the Clock (fixed, so a
 * TestClock run is exact and a rehearsal is repeatable).
 */
export const hinted = (
  lines: ReadonlyArray<{ readonly text: string; readonly decider?: Line }>,
  options: { readonly latencyMs: number }
) =>
  ScriptedDecider.layerWith((request) =>
    Effect.sleep(`${options.latencyMs} millis`).pipe(
      Effect.flatMap(() => {
        try {
          return Effect.succeed(answerLine(request, Option.getOrElse(hintsFor(lines, request.state), () => ({}))))
        } catch (e) {
          return Effect.fail(invalid(e))
        }
      })
    )
  )
