/**
 * Turn a contradicted claim into one short, evidence-backed sentence.
 *
 * `Writer.template` is the offline default so the loop runs without AWS credentials. The
 * Bedrock writer (Bedrock.ts) provides the same service.
 */
import { Context, Effect, Layer, Schema } from "effect"
import type { LedgerItem } from "./Ledger.ts"

/** Bedrock (or another support model) failed while writing or routing. */
export class SupportError extends Schema.TaggedError<SupportError>()("SupportError", {
  operation: Schema.Literals(["write", "route", "investigate"]),
  cause: Schema.Defect()
}) {}

export const templateLine = (item: LedgerItem): string =>
  `Quick flag on ${item.speaker}'s point: ${item.resource} ${item.evidence}.`

export class Writer extends Context.Service<Writer, {
  write(item: LedgerItem): Effect.Effect<string, SupportError>
}>()("egghead/Speaker/Writer") {
  static readonly template = Layer.succeed(Writer, Writer.of({ write: (item) => Effect.succeed(templateLine(item)) }))
}
