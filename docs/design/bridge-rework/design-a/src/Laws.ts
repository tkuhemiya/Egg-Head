/**
 * Laws: the rules spec/Bridge.tla checks, as predicates over (state before, Transition). One name each,
 * identical to the TLA+ property. Used by test/Laws.test.ts, which explores the real reducer over a
 * bounded alphabet of inputs (the same nondeterminism the TLA model uses) and by scenarios as a
 * cheap runtime assertion. TLC still checks liveness over unbounded behaviours; these check the code.
 */
import type { State, Transition } from "./State.ts"

export type Violation = { readonly law: string; readonly detail: string }
export type Law = (before: State, t: Transition) => ReadonlyArray<Violation>

/** Said firm => the claim was Standing{confirmed}, or direct mode (policy.secondLook false). */
export const NeverFirmOnUnconfirmed: Law = () => { throw new Error("not implemented") }
/** A tentative barge on a claim => that claim is Checking (a job exists) after the transition. */
export const TentativeIsChecked: Law = () => { throw new Error("not implemented") }
/** No speech about a claim the call corrected (phase Closed{Corrected}) or parked. */
export const NeverSaysCorrected: Law = () => { throw new Error("not implemented") }
/** Firm speech about a claim whose second look found it right never happens (tentative ones owe a retraction instead). */
export const NeverFirmRightClaimIsWrong: Law = () => { throw new Error("not implemented") }
/** Two Egg Head speeches only with a human line between them or quietAfterSpeechS after the first ended. */
export const OneLinePerGap: Law = () => { throw new Error("not implemented") }
/** A Parked closure only touches claims whose resource the parking verdict named. */
export const ParkingIsScoped: Law = () => { throw new Error("not implemented") }
/** Every Running job has a deadline; no phase references a Finished job. */
export const JobsEnd: Law = () => { throw new Error("not implemented") }

/** Liveness, checked by draining: from any reachable state, Sweep far in the future plus open-floor Silence ticks reach quiescence. */
export const AckIsAnswered = (_s: State): boolean => { throw new Error("not implemented") } // no request Working; every Ready is sayable
export const ConfirmedIsResolved = (_s: State): boolean => { throw new Error("not implemented") } // no Standing claim, no owed retraction
export const all: ReadonlyArray<readonly [string, Law]> = [
  ["NeverFirmOnUnconfirmed", NeverFirmOnUnconfirmed], ["TentativeIsChecked", TentativeIsChecked], ["NeverSaysCorrected", NeverSaysCorrected],
  ["NeverFirmRightClaimIsWrong", NeverFirmRightClaimIsWrong], ["OneLinePerGap", OneLinePerGap], ["ParkingIsScoped", ParkingIsScoped], ["JobsEnd", JobsEnd]
]
