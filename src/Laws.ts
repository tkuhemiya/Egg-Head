/**
 * TLA+ rules as predicates over (state before, Transition).
 */
import { Option } from "effect"
import * as Claims from "./Claims.ts"
import * as Jobs from "./Jobs.ts"
import type { State, Transition } from "./State.ts"

export type Violation = { readonly law: string; readonly detail: string }
export type Law = (before: State, t: Transition) => ReadonlyArray<Violation>

const speeches = (t: Transition) =>
  Option.flatMap(t.event, (e) => e.speech && Option.isSome(e.speech) ? Option.some(e.speech.value) : Option.none())

export const NeverFirmOnUnconfirmed: Law = (_before, t) => {
  const sp = speeches(t)
  if (Option.isNone(sp) || sp.value.certainty !== "firm") return []
  if (sp.value.kind !== "flag" && sp.value.kind !== "barge") return []
  const basis = Option.getOrUndefined(sp.value.basis)
  if (basis === "fastCheck" && t.state.claims.some((c) => c.phase._tag !== "Closed" && c.phase._tag !== "Standing")) {
    return [{ law: "NeverFirmOnUnconfirmed", detail: "firm speech on an unconfirmed claim" }]
  }
  return []
}

export const TentativeIsChecked: Law = (_before, t) => {
  const v: Array<Violation> = []
  for (const c of t.state.claims) {
    if (c.toldTentatively && c.phase._tag !== "Checking" && c.phase._tag !== "Standing" && c.phase._tag !== "Closed") {
      v.push({ law: "TentativeIsChecked", detail: String(c.id) })
    }
  }
  return v
}

export const NeverSaysCorrected: Law = (before, t) => {
  const sp = speeches(t)
  if (Option.isNone(sp) || (sp.value.kind !== "flag" && sp.value.kind !== "barge")) return []
  const about = Option.getOrUndefined(sp.value.about)
  const closed = before.claims.find((c) => c.resource === about && c.phase._tag === "Closed" && (c.phase.why._tag === "Corrected" || c.phase.why._tag === "Parked"))
  return closed ? [{ law: "NeverSaysCorrected", detail: String(closed.id) }] : []
}

export const NeverFirmRightClaimIsWrong: Law = (before, t) => {
  const sp = speeches(t)
  if (Option.isNone(sp) || sp.value.certainty !== "firm") return []
  const about = Option.getOrUndefined(sp.value.about)
  const c = before.claims.find((x) => x.resource === about && x.phase._tag === "Closed" && x.phase.why._tag === "Overruled")
  return c ? [{ law: "NeverFirmRightClaimIsWrong", detail: String(c.id) }] : []
}

export const OneLinePerGap: Law = (before, t) => {
  const sp = speeches(t)
  if (Option.isNone(sp)) return []
  if (before.floor.phase._tag === "Speaking" || before.floor.phase._tag === "Composing") {
    return [{ law: "OneLinePerGap", detail: "spoke while floor not open" }]
  }
  return []
}

export const ParkingIsScoped: Law = (before, t) => {
  const v: Array<Violation> = []
  for (const m of t.event.pipe(Option.map((e) => e.moves ?? []), Option.getOrElse(() => []))) {
    if (m._tag !== "Closed" || m.why !== "parked") continue
    const c = before.claims.find((x) => x.id === m.claim)
    if (c && c.resource !== m.resource) v.push({ law: "ParkingIsScoped", detail: String(m.claim) })
  }
  return v
}

export const JobsEnd: Law = (_before, t) => {
  const v: Array<Violation> = []
  for (const job of Object.values(t.state.jobs.table)) {
    if (job.phase._tag === "Running" && job.deadlineAt < 0) v.push({ law: "JobsEnd", detail: job.id })
  }
  return v
}

export const AckIsAnswered = (s: State): boolean =>
  s.requests.every((r) => r.phase._tag !== "Working" || Jobs.running(s.jobs).some((j) => j.subject._tag === "Request" && j.subject.id === r.id))

export const ConfirmedIsResolved = (s: State): boolean =>
  Claims.standing(s.claims).length < 100

export const all: ReadonlyArray<readonly [string, Law]> = [
  ["NeverFirmOnUnconfirmed", NeverFirmOnUnconfirmed],
  ["TentativeIsChecked", TentativeIsChecked],
  ["NeverSaysCorrected", NeverSaysCorrected],
  ["NeverFirmRightClaimIsWrong", NeverFirmRightClaimIsWrong],
  ["OneLinePerGap", OneLinePerGap],
  ["ParkingIsScoped", ParkingIsScoped],
  ["JobsEnd", JobsEnd]
]
