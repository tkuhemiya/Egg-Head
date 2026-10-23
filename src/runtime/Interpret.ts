/**
 * Interpreter: run commands from a committed Transition. Jobs start here, never inside reduce.
 */
import { Duration, Effect, Option, type Scope } from "effect"
import * as Claims from "../domain/Claims.ts"
import type { CheckSource } from "../domain/Checks.ts"
import { blankEvent, type Event as Ev } from "../domain/Event.ts"
import { jobNumber } from "../domain/Ids.ts"
import { direct, Investigator } from "./Investigator.ts"
import type { Outcome } from "../domain/Jobs.ts"
import { type SupportError, templateLine, Writer } from "../domain/Speaker.ts"
import type { Command, Input, Policy, Transition } from "../domain/State.ts"

export type Transact = (input: Input) => Effect.Effect<Transition>

export const interpret = (deps: {
  readonly transact: Transact
  readonly writer: Writer["Service"]
  readonly source: CheckSource["Service"]
  readonly investigator: Option.Option<Investigator["Service"]>
  readonly policy: Policy
  readonly scope: Scope.Scope
}) => {
  const runJob = (cmd: Command) => {
    if (cmd._tag !== "StartJob") return Effect.void
    const { job, payload } = cmd
    const inv = job.via === "investigator" && Option.isSome(deps.investigator) ? deps.investigator.value : direct(deps.source)
    const task = jobNumber(job.id)
    const body: Effect.Effect<Outcome> = payload.kind === "answer"
      ? inv.answer(task, payload.question).pipe(
        Effect.map((text): Outcome => ({ _tag: "Reported", report: { _tag: "Answered", text, by: inv.name } })),
        Effect.catch((e: SupportError): Effect.Effect<Outcome> =>
          Effect.succeed(
            String(e.cause).includes("no resource")
              ? { _tag: "Reported", report: { _tag: "Unknown", why: "no resource named in the question", by: inv.name } }
              : { _tag: "Failed", reason: String(e.cause) }
          )
        )
      )
      : inv.confirm(task, Claims.toLedgerItem(payload.claim, true)).pipe(
        Effect.map((f): Outcome =>
          f.status === "unknown"
            ? { _tag: "Reported", report: { _tag: "Unknown", why: f.fact.slice(0, 240), by: f.by } }
            : { _tag: "Reported", report: { _tag: "Checked", status: f.status, fact: f.fact.slice(0, 240), by: f.by } }
        ),
        Effect.catch((e: SupportError): Effect.Effect<Outcome> => Effect.succeed({ _tag: "Failed", reason: String(e.cause) }))
      )
    const seconds = Math.max(0.05, job.deadlineAt - job.startedAt)
    return body.pipe(
      Effect.timeoutOption(Duration.seconds(seconds)),
      Effect.flatMap((opt) =>
        deps.transact({
          _tag: "JobDone",
          id: job.id,
          outcome: Option.match(opt, { onNone: () => ({ _tag: "TimedOut" as const }), onSome: (o) => o })
        })
      ),
      Effect.flatMap((t) => apply(t)),
      Effect.catchCause(Effect.logError),
      Effect.forkIn(deps.scope),
      Effect.asVoid
    )
  }

  const apply = (t: Transition): Effect.Effect<Ev, SupportError> =>
    Effect.gen(function*() {
      let current = t
      for (const cmd of t.commands) {
        if (cmd._tag === "StartJob") yield* runJob(cmd)
        if (cmd._tag === "Compose") {
          const item = Claims.toLedgerItem(cmd.claim, deps.policy.secondLook)
          const text = yield* deps.writer.write(item).pipe(Effect.catch(() => Effect.succeed(templateLine(item))))
          current = yield* deps.transact({ _tag: "Composed", id: cmd.id, text: Option.some(text) })
        }
      }
      return Option.getOrElse(current.event, () => Option.getOrElse(t.event, () => blankEvent(0, "", "")))
    })

  return apply
}
