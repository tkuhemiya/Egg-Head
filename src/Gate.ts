/**
 * SpeakGate: should Egg Head interrupt the call with a contradicted claim?
 *
 * Pass-2 spike findings (spike/REPORT.md) decide who owns what:
 *
 * - `floor_free` (asked as "would speaking interrupt?" and inverted) was 87% accurate, but it
 *   missed the cases where someone was still mid-thought. Decider stays the gap detector and
 *   code adds a hard minimum of VAD silence.
 * - `self_repaired` was 69% and overlapped too much to threshold. Repair is now keyword
 *   overlay on the turns after the claim, or a later true claim for the same resource
 *   (from the ClaimCheckRouter). The Decider answer stays as a weak third vote.
 * - `silence_cost` was 12% and sat near 0.4 on every snippet. Cost is now derived from the
 *   check that disagreed, and drops when the call parked the topic.
 *
 * All of it is plain code over the Decider probabilities, so each decision can be shown on
 * the dashboard with the reason it was made. `spike/egghead_gate.py` is the frozen Python
 * original; test/Gate.parity.test.ts holds this port to it.
 */
import { Option, Schema } from "effect"

export const LEVELS = ["none", "low", "moderate", "high", "critical"] as const

export const T_SELF_REPAIRED = 0.45 // Decider vote only; the keyword and ledger signals decide most cases
export const T_FLOOR = 0.5 // P(natural gap) after inverting the interrupt question
export const T_MIN_SILENCE_S = 0.5 // never speak over a live voice, whatever the Decider says
export const T_SILENCE_S = 1.2 // this much silence opens the gate on its own
export const T_COST_LEVEL = 2 // moderate: do not interrupt for less
export const COOLDOWN_S = 30.0

/** The numbers `decide` compares against. Defaults are the constants above (src/Tuning.ts overrides them). */
export interface GateTuning {
  readonly selfRepaired: number
  readonly floor: number
  readonly minSilenceS: number
  readonly silenceS: number
  readonly costLevel: number
  readonly cooldownS: number
}

export const GATE_DEFAULTS: GateTuning = {
  selfRepaired: T_SELF_REPAIRED,
  floor: T_FLOOR,
  minSilenceS: T_MIN_SILENCE_S,
  silenceS: T_SILENCE_S,
  costLevel: T_COST_LEVEL,
  cooldownS: COOLDOWN_S
}

// Base cost of staying silent per check type: how much a wrong belief about it misdirects
// an incident (deploys and databases are the usual wrong turns; an alarm list is context).
export const BASE_COST: Readonly<Record<string, number>> = {
  db_health: 3,
  service_error_rate: 3,
  recent_deploys: 3,
  queue_depth: 3,
  latency_p99: 2,
  alarm_state: 2
}
const DOWN_BUMP = 1 // a check that says "down" is worse than "degraded"

const REPAIR = new RegExp(
  [
    String.raw`\bwait\b`,
    String.raw`\bhold on\b`,
    String.raw`\bare you sure\b`,
    String.raw`\bhow sure\b`,
    String.raw`\bI was (?:looking|wrong)\b`,
    String.raw`\bthat'?s not (?:right|true)\b`,
    String.raw`\bactually\b`
  ].join("|"),
  "i"
)
const PARKED = new RegExp(
  [
    String.raw`\bpark(?:ed|ing)?\b`,
    String.raw`\bnot in the (?:\w+ )?path\b`,
    String.raw`\bset (?:that|it) aside\b`,
    String.raw`\bstay on\b`,
    String.raw`\bback to that later\b`
  ].join("|"),
  "i"
)

export interface GateInput {
  readonly check: string
  readonly status: string // live check status for the flagged claim
  readonly laterTurns: ReadonlyArray<string> // utterance text after the flagged claim, oldest first
  readonly silenceS: number // VAD silence since the last voice
  readonly selfRepairedP: number // Decider noul, P(someone already corrected it)
  readonly interruptP: number // Decider noul, P(speaking now would interrupt)
  readonly laterClaimSupportsCheck?: boolean // router found a later true claim on this resource
  readonly secondsSinceLastSpoke?: number
}

export const Reason = Schema.Literals(["persisted", "not_repaired", "min_silence", "floor_open", "worth_it", "cooldown"])
export type Reason = typeof Reason.Type
export const RepairedBy = Schema.Literals(["ledger", "keyword", "decider"])
export type RepairedBy = typeof RepairedBy.Type

export const GateDecision = Schema.Struct({
  speak: Schema.Boolean,
  blockedBy: Schema.OptionFromNullOr(Reason), // first reason that failed, in Reason order
  repairedBy: Schema.OptionFromNullOr(RepairedBy),
  costLevel: Schema.Int,
  floorP: Schema.Number,
  reasons: Schema.Record(Reason, Schema.Boolean)
})
export type GateDecision = typeof GateDecision.Type

/** Why this claim no longer needs raising. */
export const repairedBy = (g: GateInput, t: GateTuning = GATE_DEFAULTS): Option.Option<RepairedBy> => {
  if (g.laterClaimSupportsCheck) return Option.some("ledger")
  if (g.laterTurns.some((turn) => REPAIR.test(turn))) return Option.some("keyword")
  if (g.selfRepairedP >= t.selfRepaired) return Option.some("decider")
  return Option.none()
}

/** How harmful silence is, from the check that disagreed. 0 none ... 4 critical. */
export const costLevel = (g: GateInput): number => {
  if (g.laterTurns.some((t) => PARKED.test(t))) return 1
  const level = (BASE_COST[g.check] ?? 2) + (g.status === "down" ? DOWN_BUMP : 0)
  return Math.min(level, LEVELS.length - 1)
}

export const decide = (g: GateInput, t: GateTuning = GATE_DEFAULTS): GateDecision => {
  const floorP = 1 - g.interruptP
  const rep = repairedBy(g, t)
  const level = costLevel(g)
  const reasons: Record<Reason, boolean> = {
    persisted: g.laterTurns.length > 0, // the call has moved on at least one turn since the claim
    not_repaired: Option.isNone(rep),
    min_silence: g.silenceS >= t.minSilenceS,
    floor_open: floorP >= t.floor || g.silenceS >= t.silenceS,
    worth_it: level >= t.costLevel,
    cooldown: (g.secondsSinceLastSpoke ?? Infinity) >= t.cooldownS
  }
  const blockedBy = Option.fromUndefinedOr(Reason.literals.find((k) => !reasons[k]))
  return { speak: Option.isNone(blockedBy), blockedBy, repairedBy: rep, costLevel: level, floorP, reasons }
}
