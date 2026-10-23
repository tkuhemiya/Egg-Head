/**
 * What Egg Head would say next. Reads; Step applies through the owners.
 */
import { Option } from "effect"
import type { Claim } from "./Claims.ts"
import * as Claims from "./Claims.ts"
import * as C from "./Conversation.ts"
import type { GateDecision } from "./Gate.ts"
import * as G from "./Gate.ts"
import * as Floor from "./Floor.ts"
import type { Request } from "./Requests.ts"
import type { Ctx, State } from "./State.ts"

export type Intent =
  | { readonly _tag: "Answer"; readonly request: Request }
  | { readonly _tag: "Ack"; readonly request: Request; readonly why: string }
  | { readonly _tag: "Take"; readonly request: Request }
  | { readonly _tag: "Retract"; readonly claim: Claim }
  | { readonly _tag: "Flag"; readonly claim: Claim; readonly gate: GateDecision }

export interface Pick {
  readonly intent: Option.Option<Intent>
  readonly gate: Option.Option<GateDecision>
  readonly held: Option.Option<"speaking" | "composing" | "analysing" | "oneLinePerGap">
  readonly notes: ReadonlyArray<string>
}

const gateOf = (s: State, c: Claim, silenceS: number, ctx: Ctx): GateDecision => {
  const laterTurns = s.turns.slice(c.turn + 1).map(([, t]) => t)
  const lastUnprompted = Option.getOrElse(s.floor.lastUnpromptedAt, () => -Infinity)
  const closed = c.phase._tag === "Closed" ? c.phase.why : undefined
  return G.decide({
    check: c.check,
    status: c.status,
    laterTurns,
    silenceS,
    selfRepairedP: s.selfRepairedP,
    interruptP: s.interruptP,
    laterClaimSupportsCheck: closed?._tag === "Corrected" && closed.by === "ledger",
    secondsSinceLastSpoke: ctx.now - lastUnprompted,
    parked: closed?._tag === "Parked",
    correctedBy: closed?._tag === "Corrected" ? Option.some(closed.by) : Option.none(),
    turnsSince: laterTurns.length
  }, ctx.tuning.gate)
}

export const next = (s: State, silenceS: number, ctx: Ctx, alsoGate: ReadonlyArray<Claim> = []): Pick => {
  const notes: Array<string> = []
  const standing = Claims.standing(s.claims)
  const head = standing[0] ?? alsoGate[0]
  const gate = head ? Option.some(gateOf(s, head, silenceS, ctx)) : Option.none()

  const ready = s.requests.find((r) => r.phase._tag === "Ready")
  const listening = s.requests.find((r) => r.phase._tag === "Listening")
  const retract = s.claims.find((c) => c.retractionOwed)
  const flaggable = standing.find((c) => gateOf(s, c, silenceS, ctx).speak)

  let intent: Option.Option<Intent> = Option.none()
  if (ready && silenceS >= ctx.tuning.gate.minSilenceS) intent = Option.some({ _tag: "Answer", request: ready })
  else if (listening && silenceS >= ctx.tuning.gate.minSilenceS) {
    if (listening.kind === "addressed") {
      const r = C.readyToReply({ finishedP: s.finishedP, text: listening.text, silenceS }, ctx.tuning)
      if (!r.ready) {
        const key = `${listening.id}:${r.why}`
        if (silenceS >= 1.0 && !s.notes.includes(key)) {
          notes.push(`${listening.speaker} is talking to Egg Head but has not finished: ${r.why}. Waiting.`)
        }
      } else intent = Option.some({ _tag: "Ack", request: listening, why: r.why })
    } else {
      const latestBy = s.turns[s.turns.length - 1]?.[0]
      if (latestBy === listening.speaker && silenceS >= ctx.tuning.openSilenceS) {
        intent = Option.some({ _tag: "Take", request: listening })
      }
    }
  }
  if (Option.isNone(intent) && retract) intent = Option.some({ _tag: "Retract", claim: retract })
  if (Option.isNone(intent) && flaggable) intent = Option.some({ _tag: "Flag", claim: flaggable, gate: gateOf(s, flaggable, silenceS, ctx) })

  if (s.analysing > 0) {
    return { intent, gate, held: Option.some("analysing"), notes }
  }
  const may = Floor.mayStart(s.floor, s.turns.length, ctx.now, ctx.tuning)
  if (Option.isSome(intent) && !may.ok) {
    return { intent, gate, held: Option.some(may.why), notes }
  }
  if (!G.gapOpen(1 - s.interruptP, silenceS, ctx.tuning.gate) && Option.isSome(intent) && intent.value._tag !== "Flag") {
    // acks/answers/takes still need the floor-open silence rule (minSilence already applied)
    if (silenceS < ctx.tuning.gate.minSilenceS) {
      return { intent, gate, held: Option.some("oneLinePerGap"), notes }
    }
  }
  return { intent: may.ok ? intent : Option.none(), gate, held: may.ok ? Option.none() : Option.some(may.why), notes }
}
