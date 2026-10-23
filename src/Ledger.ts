/**
 * Ledger items: the public shape of a contradicted claim (`Bridge.state`, the Writer, the
 * Investigator). The claim lifecycle itself lives in Claims.ts.
 */
import { Schema } from "effect"
import { Status } from "./Checks.ts"

export const LedgerItem = Schema.Struct({
  speaker: Schema.String,
  claim: Schema.String,
  check: Schema.String,
  resource: Schema.String,
  status: Status, // what the check returned
  evidence: Schema.String,
  turn: Schema.Int, // index of the claim in the transcript
  raised: Schema.Boolean,
  /** With an Investigator: the second look before Egg Head interrupts with it. */
  agent: Schema.optionalKey(Schema.Literals(["pending", "checking", "confirmed", "overruled", "skipped"])),
  /** What the Investigator found, in spoken words. */
  fact: Schema.optionalKey(Schema.String),
  asserted: Schema.optionalKey(Schema.String)
})
export type LedgerItem = typeof LedgerItem.Type

export type Ledger = ReadonlyArray<LedgerItem>
