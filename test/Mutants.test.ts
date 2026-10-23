/**
 * The scenarios have to be able to fail. Each mutant builds the Bridge with one deliberately
 * wrong number (src/Tuning.ts) and some line of some scenario in data/calls/ must then
 * misbehave. A surviving mutant means the Bridge compares against a constant around Tuning, or
 * no scenario pins that behaviour down.
 */
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { readdirSync, readFileSync } from "node:fs"
import { decodeCall } from "../src/runtime/Call.ts"
import { describeOutcome } from "../src/domain/Expect.ts"
import type { Report } from "../src/runtime/Judge.ts"
import type { TuningPatch } from "../src/domain/Tuning.ts"
import { score } from "./harness/Offline.ts"

const MUTANTS: ReadonlyArray<readonly [name: string, tuning: TuningPatch]> = [
  ["takes a hanging question after 1 s (OPEN_SILENCE_S)", { openSilenceS: 1.0 }],
  ["never barges in (T_DIRECTIVE)", { directive: 1.01 }],
  ["replies to a speaker who trailed off after 1 s (REPLY_MAX_WAIT_S)", { replyMaxWaitS: 1.0 }],
  ["speaks over a live voice (T_MIN_SILENCE_S)", { gate: { minSilenceS: 0 } }],
  ["half a second of silence opens the floor (T_SILENCE_S)", { gate: { silenceS: 0.5 } }],
  ["ignores Decider's end of turn on the floor (T_FLOOR)", { gate: { floor: 1.01 } }],
  ["never notices it is spoken to (T_ADDRESSED)", { addressed: 1.01 }],
  ["never takes a question to the call (T_ASKS)", { asks: 1.01 }],
  ["never believes the speaker has finished (finished)", { finished: 1.01 }],
  ["no cooldown between flags (cooldown)", { gate: { cooldownS: 0 } }]
]

const DIR = new URL("../data/calls/", import.meta.url)
const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()

const firstFailure = (file: string, r: Report): string | undefined => {
  const line = r.lines.find((l) => !l.ok)
  if (line) {
    const p = line.problems[0]!
    const what = p._tag === "NotPlayed"
      ? "not played"
      : p._tag === "Unexpected"
      ? `unexpected ${p.observed._tag === "Said" ? p.observed.kind : `investigates (${p.observed.job})`}`
      : p._tag === "Missing"
      ? `missing ${describeOutcome(p.expected)}`
      : `${describeOutcome(p.expected)}: ${p.fields.join(", ")} differ`
    return `${file} line ${line.index} (${line.trace.speaker}: "${line.trace.text}"): ${what}`
  }
  const inv = r.invariants.find((i) => !i.ok)
  return inv ? `${file} invariant ${inv.invariant._tag}: ${inv.detail}` : undefined
}

describe("every mutant is caught by a scenario", () => {
  for (const [name, tuning] of MUTANTS) {
    it.effect(name, () =>
      Effect.gen(function*() {
        let killed: string | undefined
        for (const file of files) {
          const call = yield* decodeCall(JSON.parse(readFileSync(new URL(file, DIR), "utf8")))
          killed = firstFailure(file, yield* score(call, { tuning }))
          if (killed) break
        }
        assert.isDefined(killed, `mutant survived every scenario: ${name}`)
        console.info(`${name}\n  caught by ${killed}`)
      }), 60_000)
  }
})
