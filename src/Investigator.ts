/**
 * Investigator: the expensive path Egg Head takes only when Decider and the gate say it is
 * worth it. In the demo it is a coding agent (pi on Bedrock) in a real terminal, checking with
 * the AWS CLI; any agent with a shell can stand in (demo/Agent.ts).
 *
 * Two jobs:
 * - confirm a claim the fast check contradicted, before Egg Head interrupts anyone with it;
 * - answer a question someone asked Egg Head, or one the call left hanging.
 *
 * `Investigator.direct` answers both from the CheckSource with no model at all: tests use it,
 * and the Bridge falls back to it when the agent fails or takes too long.
 */
import { Context, Effect, Layer, Option, Schema } from "effect"
import { CheckSource, Status } from "./Checks.ts"
import { factOf } from "./Conversation.ts"
import type { LedgerItem } from "./Ledger.ts"
import { aliasHits } from "./Router.ts"
import { SupportError } from "./Speaker.ts"

export const Finding = Schema.Struct({
  status: Schema.Literals([...Status.literals, "unknown"]),
  fact: Schema.String, // what was found, in words that can be spoken
  by: Schema.String // who found it: "agent" or "direct"
})
export type Finding = typeof Finding.Type

export interface Question {
  readonly speaker: string
  readonly text: string // the whole question, joined across the speaker's segments
  readonly addressed: boolean // asked of Egg Head by name, or left open to the call
}

export class Investigator extends Context.Service<Investigator, {
  /** Who investigates, for the dashboard ("direct", or the agent and its model). */
  readonly name: string
  /** Re-check a contradicted claim. `task` numbers the job for the terminal and the dashboard. */
  confirm(task: number, item: LedgerItem): Effect.Effect<Finding, SupportError>
  /** One spoken sentence that answers the question. */
  answer(task: number, question: Question): Effect.Effect<string, SupportError>
}>()("egghead/Investigator") {
  /** No model: the claim's own check, or the check a question's words point at. */
  static readonly direct = Layer.effect(Investigator, Effect.gen(function*() {
    return direct(yield* CheckSource)
  }))
}

export const direct = (source: CheckSource["Service"]): Investigator["Service"] =>
  Investigator.of({
    name: "direct",
    confirm: (_task, item) =>
      Effect.map(source.run(item.check, item.resource), (res) =>
        Option.match(res, {
          onNone: () => ({ status: item.status, fact: factOf(item), by: "direct" }),
          onSome: (r) => ({ status: r.status, fact: factOf(r), by: "direct" })
        })),
    answer: (_task, question) =>
      Effect.gen(function*() {
        const { checks } = yield* source.inventory
        const resource = aliasHits(question.text)[0]
        if (resource === undefined) {
          return yield* Effect.fail(new SupportError({ operation: "investigate", cause: "no resource named in the question" }))
        }
        const own = checks[resource] ?? []
        const check = QUESTION_CHECKS.find(([c, p]) => own.includes(c) && p.test(question.text))?.[0] ?? own[0]
        const res = check ? yield* source.run(check, resource) : Option.none()
        return Option.match(res, {
          onNone: () => `I have no check for ${resource} that answers that.`,
          onSome: (r) => `${r.resource}: ${r.evidence}.`
        })
      })
  })

/** Which check a question's words point at, in order of preference. */
export const QUESTION_CHECKS: ReadonlyArray<readonly [string, RegExp]> = [
  ["recent_deploys", /deploy|push|release|ship|went out/i],
  ["queue_depth", /queue|backed up|backlog/i],
  ["latency_p99", /slow|latency|p99/i],
  ["db_health", /cpu|database|\bdb\b/i],
  ["service_error_rate", /error|5\d\d|fail/i],
  ["alarm_state", /alarm/i]
]
