/**
 * Rehearsal Decider: answers from each call line's `decider` hints, with the hosted API's
 * latency, so the whole demo (meeting page, terminal agent, timing) can be rehearsed with no
 * network. A partial transcript gets the answers of the line it is the start of. Lines with no
 * hints are "not a claim, nobody is asking anything".
 *
 * Real runs ask the hosted Decider; the hints are what we expect it to say, not what it said.
 */
import { Effect } from "effect"
import { ScriptedDecider } from "../src/Decider.ts"
import { answerLine, type Line, latestOf } from "../test/helpers.ts"
import type { Call } from "./Run.ts"

const latestOrEmpty = (state: unknown) => {
  try {
    return latestOf(state)
  } catch {
    return "" // the warm-up request has no transcript
  }
}

export const rehearsalDecider = (call: Call) => {
  const lines = call.lines.map((l) => [l.text, (l.decider ?? {}) as Line] as const)
  const lineFor = (latest: string): Line =>
    lines.find(([text]) => text === latest)?.[1] ??
      lines.find(([text]) => latest.length > 3 && text.startsWith(latest.replace(/—$/, "")))?.[1] ??
      {}
  return ScriptedDecider.layerWith((request) =>
    Effect.sleep(`${120 + Math.round(Math.random() * 180)} millis`).pipe(
      Effect.as(answerLine(request, lineFor(latestOrEmpty(request.state))))
    )
  )
}
