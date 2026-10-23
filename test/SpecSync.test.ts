/**
 * Keep spec/Bridge.tla in step with the reducer vocabulary.
 */
import { assert, it } from "@effect/vitest"
import { readFileSync } from "node:fs"
import { CLAIM_TAGS } from "../src/domain/Claims.ts"
import { FLOOR_TAGS } from "../src/domain/Floor.ts"
import { JOB_TAGS } from "../src/domain/Jobs.ts"
import { REQUEST_TAGS } from "../src/domain/Requests.ts"
import { INPUT_TAGS } from "../src/domain/State.ts"

const spec = readFileSync(new URL("../spec/Bridge.tla", import.meta.url), "utf8")
const set = (name: string): ReadonlyArray<string> => {
  const m = spec.match(new RegExp(`${name} == \\{([^}]*)\\}`))
  return m ? [...m[1]!.matchAll(/"(\w+)"/g)].map((x) => x[1]!).sort() : []
}

it("the TLA+ model has the code's statuses and inputs", () => {
  assert.deepStrictEqual(set("ClaimStatuses"), [...CLAIM_TAGS].sort())
  assert.deepStrictEqual(set("RequestStatuses"), [...REQUEST_TAGS].sort())
  assert.deepStrictEqual(set("JobStatuses"), [...JOB_TAGS].sort())
  assert.deepStrictEqual(set("SpeechStatuses"), [...FLOOR_TAGS].sort())
  const actions = [...spec.matchAll(/\\\* input: (\w+)/g)].map((m) => m[1]!).sort()
  assert.deepStrictEqual(actions, [...INPUT_TAGS].sort())
})
