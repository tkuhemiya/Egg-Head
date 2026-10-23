/**
 * Live Bedrock probe (costs money: two short calls, well under $0.01 on Nemotron Nano 3).
 * Checks that EGGHEAD_MODEL_ID does tool use (the writer calls run_check) and structured
 * output (the escalation route) through the Strands TS agent.
 *
 *   npx tsx --env-file=.env scripts/probe-bedrock.ts
 */
import { Console, Effect, Layer, Option } from "effect"
import { BedrockSupport } from "../src/runtime/Bedrock.ts"
import { MockSource } from "../src/domain/Checks.ts"

const program = Effect.gen(function*() {
  const support = yield* BedrockSupport
  const [writeMs, line] = yield* Effect.timed(support.write({
    speaker: "Sam",
    claim: "The orders DB is fine, CPU is normal.",
    check: "db_health",
    resource: "orders-db",
    status: "degraded",
    evidence: "CPU 98% for the last 6 min; alarm OrdersDB-CPU in ALARM",
    turn: 1,
    raised: false
  }))
  yield* Console.log(`write (${writeMs}): ${line}`)

  const [routeMs, route] = yield* Effect.timed(support.route([
    ["Priya", "Checkout is failing for some users. What are we seeing?"],
    ["Sam", "The orders DB is fine, it's the API."]
  ]))
  yield* Console.log(`route (${routeMs}): ${route.action} ${Option.getOrNull(route.check)} on ${Option.getOrNull(route.resource)}, asserted ${Option.getOrNull(route.asserted)}`)
  yield* Console.log(`calls: ${JSON.stringify(yield* support.calls)}`)
})

Effect.runPromise(program.pipe(Effect.provide(BedrockSupport.layer().pipe(Layer.provideMerge(MockSource.layer())))))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
