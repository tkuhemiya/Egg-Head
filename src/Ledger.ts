/**
 * Claim ledger: checked claims that contradict a live check and have not been raised yet.
 * Immutable: every operation returns a new ledger; the Bridge keeps the current one in a Ref.
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

export const empty: Ledger = []

const sameClaim = (a: LedgerItem, b: LedgerItem) => a.check === b.check && a.resource === b.resource

/** Open (not yet raised) items, oldest first. */
export const open = (ledger: Ledger): Ledger => ledger.filter((i) => !i.raised)

/** Add a contradicted claim. Unchanged when the same check+resource is already open. */
export const add = (ledger: Ledger, item: LedgerItem): Ledger =>
  ledger.some((i) => !i.raised && sameClaim(i, item)) ? ledger : [...ledger, item]

/** Close an item: it was said out loud, or the call corrected itself. */
export const markRaised = (ledger: Ledger, item: LedgerItem): Ledger =>
  ledger.map((i) => (i === item ? { ...i, raised: true } : i))

/** The same item (by claim turn and check) with some fields changed. */
export const update = (ledger: Ledger, item: LedgerItem, patch: Partial<LedgerItem>): Ledger =>
  ledger.map((i) => (i.turn === item.turn && sameClaim(i, item) ? { ...i, ...patch } : i))

export const find = (ledger: Ledger, item: LedgerItem): LedgerItem | undefined =>
  ledger.find((i) => i.turn === item.turn && sameClaim(i, item))
