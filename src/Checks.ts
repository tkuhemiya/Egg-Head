/**
 * Check registry and check sources.
 *
 * A check is a named question about live infrastructure with a one-line description. The
 * description is the Decider option label, so write it as what the check can verify. Sources
 * answer a (check, resource) pair: `MockSource` replays a scripted world with fault injection
 * for the local demo, and an AWS source can implement the same service later.
 */
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import world from "../data/world.json" with { type: "json" }

// check name -> description (the Decider option label).
export const CHECKS = {
  db_health: "Database health: CPU, connections and alarm state for a database",
  service_error_rate: "Error rate (5xx) of a service or API, including whether it is up or down",
  latency_p99: "Latency / response time (p99) of a service or API",
  recent_deploys: "Recent deploys, releases or config changes to a service",
  alarm_state: "Which CloudWatch alarms are currently firing",
  queue_depth: "Backlog / number of waiting messages in a queue"
} as const
export type CheckName = keyof typeof CHECKS

export const NONE_CHECK = "none"
export const NONE_DESCRIPTION = "None of these: the utterance cannot be verified by any check"
export const UNKNOWN_RESOURCE = "unknown"
export const UNKNOWN_DESCRIPTION = "unknown: it is unclear which single resource is meant, or it is several / none"

export const isCheck = (name: string): name is CheckName => Object.hasOwn(CHECKS, name)

export const Status = Schema.Literals(["healthy", "degraded", "down", "changed", "unchanged"])
export type Status = typeof Status.Type

export interface CheckResult {
  readonly check: string
  readonly resource: string
  readonly status: Status
  readonly evidence: string
}

const Hit = Schema.Struct({ status: Status, evidence: Schema.String })

export const World = Schema.Struct({
  resources: Schema.Record(Schema.String, Schema.String),
  checks: Schema.Record(Schema.String, Schema.Record(Schema.String, Hit))
})
export type World = typeof World.Type

export class CheckSource extends Context.Service<CheckSource, {
  /** Resource name -> one-line description, built from the live inventory. */
  readonly resources: Effect.Effect<Readonly<Record<string, string>>>
  /** Run a check. None when that check does not apply to that resource. */
  run(check: string, resource: string): Effect.Effect<Option.Option<CheckResult>>
}>()("egghead/Checks/CheckSource") {}

/** Scripted world for the local demo. `inject` flips a resource into a fault. */
export class MockSource extends Context.Service<MockSource, {
  inject(resource: string, check: string, status: Status, evidence: string): Effect.Effect<void>
}>()("egghead/Checks/MockSource") {
  static readonly make = Effect.fnUntraced(function*(input: unknown = world) {
    const decoded = yield* Schema.decodeUnknownEffect(World)(input).pipe(Effect.orDie)
    const state = yield* Ref.make(decoded)
    const source = CheckSource.of({
      resources: Effect.map(Ref.get(state), (w) => ({ ...w.resources })),
      run: (check, resource) =>
        Effect.map(Ref.get(state), (w) =>
          Option.map(
            Option.fromNullishOr(w.checks[resource]?.[check]),
            (hit): CheckResult => ({ check, resource, status: hit.status, evidence: hit.evidence })
          ))
    })
    const mock = MockSource.of({
      inject: (resource, check, status, evidence) =>
        Ref.update(state, (w) => ({
          ...w,
          checks: { ...w.checks, [resource]: { ...w.checks[resource], [check]: { status, evidence } } }
        }))
    })
    return { source, mock }
  })

  /** Both services from `data/world.json` (or another world), sharing one state. */
  static readonly layer = (input?: unknown): Layer.Layer<CheckSource | MockSource> =>
    Layer.effectContext(
      Effect.map(MockSource.make(input), ({ source, mock }) =>
        Context.make(CheckSource, source).pipe(Context.add(MockSource, mock)))
    )
}
