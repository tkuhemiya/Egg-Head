/**
 * Expect: what a voice agent on a multi-party call should do because of each line, as data.
 *
 * Per line, `expect` is a closed list of outcomes. `[]` (the default) means quiet: no speech,
 * no investigation, nobody cut off. Anything the agent does that the list does not name fails.
 * Per call, `never` lists invariants that hold on every line.
 *
 * Every field is read from Bridge `Event` fields (src/Judge.ts), never from the spoken words,
 * so a reworded line does not fail a live run. Nothing here knows about the checkout incident:
 * "flag" is raising a claim the call got wrong, whatever the call is about.
 */
import { Schema } from "effect"

/**
 * - flag:   raises a wrong claim at a gap, unprompted
 * - ack:    spoken to by name, replies once the speaker has finished ("On it")
 * - take:   takes a question to the call that nobody answered
 * - answer: says the result of a lookup it acked or took
 * - barge:  cuts a speaker off mid-line
 */
export const SaidKind = Schema.Literals(["flag", "ack", "take", "answer", "barge", "retract"])
export type SaidKind = typeof SaidKind.Type

/** Said without being asked: these are the lines a cooldown spaces out. */
export const UNPROMPTED: ReadonlyArray<SaidKind> = ["flag", "barge"]

/** When, in seconds from the start or the end of the line the outcome belongs to. Bounds are inclusive. */
export const Timing = Schema.Struct({
  since: Schema.Literals(["lineStart", "lineEnd"]),
  minS: Schema.optionalKey(Schema.Number),
  maxS: Schema.optionalKey(Schema.Number)
}).check(Schema.makeFilter((t) =>
  t.minS === undefined || t.maxS === undefined || t.minS <= t.maxS ? undefined : `minS ${t.minS} is after maxS ${t.maxS}`
))
export type Timing = typeof Timing.Type

/** Egg Head spoke. Unset fields mean "any". */
export const Says = Schema.TaggedStruct("Says", {
  kind: SaidKind,
  /** Whom it answers: the claimant for a flag, the asker for ack/take/answer, the speaker it cut off. */
  toward: Schema.optionalKey(Schema.String),
  /** The resource it is about: the claim's resource, or the one the question names. */
  about: Schema.optionalKey(Schema.String),
  when: Schema.optionalKey(Timing),
  certainty: Schema.optionalKey(Schema.Literals(["firm", "tentative"])),
  basis: Schema.optionalKey(Schema.Literals(["confirmed", "fastCheck"]))
})
export type Says = typeof Says.Type

/** The Investigator was sent off, silently: a second look at a claim, or a question to answer. */
export const Investigates = Schema.TaggedStruct("Investigates", {
  job: Schema.Literals(["confirm", "recheck", "answer"])
})
export type Investigates = typeof Investigates.Type

export const Outcome = Schema.Union([Says, Investigates])
export type Outcome = typeof Outcome.Type

/** A cut line implies a barge and a barge implies a cut, so there is no separate "cut" outcome. */
export const Expect = Schema.Array(Outcome)
export type Expect = typeof Expect.Type

export const Invariant = Schema.Union([
  /** Egg Head and a human never talk at once, except when Egg Head barges in. */
  Schema.TaggedStruct("NoTalkOver", {}),
  /** Egg Head never starts (except to barge in) less than `minS` after a human line ended. */
  Schema.TaggedStruct("SilenceBeforeSpeaking", { minS: Schema.Number }),
  /** Between two Egg Head lines, a human speaks or there are `quietS` of silence. */
  Schema.TaggedStruct("OneLinePerGap", { quietS: Schema.Number }),
  /** A flag starts at least `s` after the previous unprompted line (flag or barge). Asked-for lines are exempt. */
  Schema.TaggedStruct("Cooldown", { s: Schema.Number }),
  Schema.TaggedStruct("MaxSpeeches", { n: Schema.Int })
])
export type Invariant = typeof Invariant.Type

// Builders for scenarios written in TypeScript; JSON scenarios write the same data.

export const quiet: Expect = []
export const says = (kind: SaidKind, o: Omit<Says, "_tag" | "kind"> = {}): Outcome => ({ _tag: "Says", kind, ...o })
export const investigates = (job: Investigates["job"]): Outcome => ({ _tag: "Investigates", job })
/** Not before `minS` after the line ended, and no later than `maxS` when given. */
export const afterEnd = (minS: number, maxS?: number): Timing => ({ since: "lineEnd", minS, ...(maxS === undefined ? {} : { maxS }) })
/** While the line is still playing (barge-in). */
export const duringLine: Timing = { since: "lineEnd", maxS: 0 }

const fmt = (s: number) => `${Number(s.toFixed(2))} s`

export const describeTiming = (t: Timing): string => {
  const from = t.since === "lineEnd" ? "after the line" : "after the line started"
  if (t.since === "lineEnd" && t.maxS === 0 && t.minS === undefined) return "during the line"
  if (t.minS !== undefined && t.maxS !== undefined) return `${fmt(t.minS)} to ${fmt(t.maxS)} ${from}`
  if (t.minS !== undefined) return `not before ${fmt(t.minS)} ${from}`
  if (t.maxS !== undefined) return `within ${fmt(t.maxS)} ${from}`
  return ""
}

export const describeOutcome = (o: Outcome): string =>
  o._tag === "Investigates"
    ? `investigates (${o.job})`
    : [o.kind, o.toward && `to ${o.toward}`, o.about && `about ${o.about}`, o.when && describeTiming(o.when)].filter(Boolean).join(" ")

/** One line for the meeting page, the dashboard and failure reports. */
export const describe = (expect: Expect): string => (expect.length === 0 ? "quiet" : expect.map(describeOutcome).join("; "))

export const describeInvariant = (i: Invariant): string => {
  switch (i._tag) {
    case "NoTalkOver":
      return "never talks over anyone (except to barge in)"
    case "SilenceBeforeSpeaking":
      return `waits ${fmt(i.minS)} of silence before speaking`
    case "OneLinePerGap":
      return `one line per gap (a human turn or ${fmt(i.quietS)} of quiet between lines)`
    case "Cooldown":
      return `${fmt(i.s)} between unprompted lines`
    case "MaxSpeeches":
      return `at most ${i.n} lines`
  }
}
