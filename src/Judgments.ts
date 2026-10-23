/**
 * Seam: three language judgments. `today` is the current rule (scoped parking, per-claim repair).
 */
import { Context, Effect, Option } from "effect"
import type { AiError } from "effect/ai"
import type { Claim } from "./Claims.ts"
import { PARKED, REPAIR } from "./Gate.ts"
import type { ClaimId, RepairedBy, RequestId } from "./Ids.ts"
import type { Request } from "./Requests.ts"
import type { Turn } from "./Questions.ts"
import { aliasHits } from "./Router.ts"

export interface LineAnswers { readonly selfRepairedP: number }
export interface LineFacts { readonly supports: ReadonlyArray<{ readonly check: string; readonly resource: string }> }

export type Query =
  | { readonly _tag: "Corrects"; readonly claim: Claim }
  | { readonly _tag: "Parks"; readonly claim: Claim }
  | { readonly _tag: "Answers"; readonly request: Request }

export interface Verdict {
  readonly query: "Corrects" | "Parks" | "Answers"
  readonly item: ClaimId | RequestId
  readonly p: number
  readonly via: RepairedBy | "regex" | "speaker" | "scoped"
}

const laterOf = (claimTurn: number, lines: ReadonlyArray<Turn>): ReadonlyArray<string> =>
  lines.slice(claimTurn + 1).map(([, t]) => t)

export const correctsToday = (
  claim: Claim,
  lines: ReadonlyArray<Turn>,
  line: LineAnswers,
  facts: LineFacts,
  selfRepaired: number
): Verdict => {
  if (facts.supports.some((s) => s.check === claim.check && s.resource === claim.resource)) {
    return { query: "Corrects", item: claim.id, p: 1, via: "ledger" }
  }
  if (laterOf(claim.turn, lines).some((t) => REPAIR.test(t))) {
    return { query: "Corrects", item: claim.id, p: 1, via: "keyword" }
  }
  return { query: "Corrects", item: claim.id, p: line.selfRepairedP, via: "decider" }
  void selfRepaired
}

export const parksToday = (
  claim: Claim,
  lines: ReadonlyArray<Turn>,
  newestId: ClaimId | undefined
): Verdict => {
  const later = laterOf(claim.turn, lines)
  for (const text of later) {
    if (!PARKED.test(text)) continue
    if (/\bstay on the (?:line|call|phone)\b/i.test(text)) continue
    const named = aliasHits(text)
    if (named.includes(claim.resource) || (named.length === 0 && claim.id === newestId)) {
      return { query: "Parks", item: claim.id, p: 1, via: "regex" }
    }
  }
  return { query: "Parks", item: claim.id, p: 0, via: "regex" }
}

export const answersToday = (request: Request, lines: ReadonlyArray<Turn>): Verdict => {
  const after = lines.slice(request.turn + 1)
  const p = after.some(([speaker]) => speaker !== request.speaker) ? 1 : 0
  return { query: "Answers", item: request.id, p, via: "speaker" }
}

export interface JudgmentsShape {
  judge(
    queries: ReadonlyArray<Query>,
    lines: ReadonlyArray<Turn>,
    line: LineAnswers,
    facts: LineFacts
  ): Effect.Effect<ReadonlyArray<Verdict>, AiError.AiError>
}

export const today: JudgmentsShape = {
  judge: (queries, lines, line, facts) =>
    Effect.sync(() => {
      const openClaims = queries.filter((q) => q._tag === "Parks" || q._tag === "Corrects").map((q) =>
        q._tag === "Parks" ? q.claim : q.claim
      )
      const newest = openClaims.length ? openClaims.reduce((a, b) => (a.turn >= b.turn ? a : b)).id : undefined
      return queries.map((q) => {
        if (q._tag === "Corrects") return correctsToday(q.claim, lines, line, facts, line.selfRepairedP)
        if (q._tag === "Parks") return parksToday(q.claim, lines, newest)
        return answersToday(q.request, lines)
      })
    })
}

export const Judgments = Context.Reference<JudgmentsShape>("egghead/Judgments", { defaultValue: () => today })

export const viaOf = (v: Verdict): Option.Option<RepairedBy> =>
  v.via === "ledger" || v.via === "keyword" || v.via === "decider" ? Option.some(v.via) : Option.none()
