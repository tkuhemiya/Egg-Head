/**
 * DELTA to src/Gate.ts. Thresholds, Reason, GateDecision, BASE_COST, costLevel's table: unchanged.
 * Gate becomes a pure function of verdicts; it no longer reads transcript text.
 *   - REPAIR and PARKED regexes MOVE to Judgments.today (src/Judgments.ts) as the "today" rule.
 *   - GateInput drops laterTurns, selfRepairedP, laterClaimSupportsCheck; gains the item-scoped verdicts.
 */
import { Option } from "effect"
import type { RepairedBy } from "./Ids.ts"
import type { GateDecision, GateTuning } from "./Gate.ts"

export interface GateInput {
  readonly check: string
  readonly status: string
  readonly turnsSince: number // lines since the claim (was laterTurns.length): `persisted`
  readonly silenceS: number // Floor.silence(): Egg Head's own speech is not silence
  readonly interruptP: number
  readonly correctedBy: Option.Option<RepairedBy> // Corrects verdict >= threshold, for THIS claim
  readonly parked: boolean // Parks verdict >= threshold, for THIS claim's resource (was: PARKED regex over all later turns)
  readonly secondsSinceLastUnprompted: number
}
export declare const decide: (g: GateInput, t?: GateTuning) => GateDecision
/** Shared with Agenda for acks and answers (was duplicated as Bridge.floorOpen). */
export declare const gapOpen: (floorP: number, silenceS: number, t: GateTuning) => boolean
