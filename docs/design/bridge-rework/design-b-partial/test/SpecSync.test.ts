/**
 * Keeps spec/Bridge.tla in step with the code it models, so a new status or input fails the
 * build instead of silently leaving the model behind (red flag: hand-synced list).
 *
 * The spec declares its vocabulary as plain TLA+ sets near the top:
 *   ClaimStatuses == {"Contradicted", "Checking", "Confirmed", "Spoken", "Correcting", "Closed"}
 *   RequestStatuses == {...}   JobStatuses == {...}   SpeechStatuses == {...}
 * and names one action per Core.Input tag (`\* input: Heard` above each action).
 * This test reads the file (no TLC needed) and compares with the lists the code exports.
 * spec/check.sh stays the way to model-check; CI runs it when java is available.
 */
import { assert, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { CLAIM_TAGS } from "../src/Claims.ts"
import { INPUT_TAGS } from "../src/Core.ts"
import { JOB_TAGS } from "../src/Jobs.ts"
import { REQUEST_TAGS } from "../src/Requests.ts"
import { SPEECH_TAGS } from "../src/Speech.ts"

const spec = readFileSync(new URL("../spec/Bridge.tla", import.meta.url), "utf8")
const set = (name: string): ReadonlyArray<string> => {
  const m = spec.match(new RegExp(`${name} == \\{([^}]*)\\}`))
  return m ? [...m[1]!.matchAll(/"(\w+)"/g)].map((x) => x[1]!).sort() : []
}

it("the TLA+ model has the code's statuses and inputs", () => {
  assert.deepStrictEqual(set("ClaimStatuses"), [...CLAIM_TAGS].sort())
  assert.deepStrictEqual(set("RequestStatuses"), [...REQUEST_TAGS].sort())
  assert.deepStrictEqual(set("JobStatuses"), [...JOB_TAGS].sort())
  assert.deepStrictEqual(set("SpeechStatuses"), [...SPEECH_TAGS].sort())
  const actions = [...spec.matchAll(/\\\* input: (\w+)/g)].map((m) => m[1]!).sort()
  assert.deepStrictEqual(actions, [...INPUT_TAGS].sort())
})
