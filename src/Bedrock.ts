/**
 * Amazon Bedrock side of Egg Head, through a Strands agent (`@strands-agents/sdk`).
 *
 * Bedrock does two jobs, and only when Decider and the gate hand it one:
 *
 * - Tool-calling agent: when the gate opens, the agent gets the contradicted claim and the
 *   registered checks as tools. It can re-run a check or read a related one, then writes the
 *   one spoken sentence from what the tools returned.
 * - Support during the call: when Decider says the latest utterance is a claim but cannot
 *   route it confidently, the agent picks the check and resource for that one utterance.
 *   Each call is counted by the Bridge.
 *
 * `deny` in `beforeModelCall` was checked in the Strands TS source (agent.js): it sets
 * `event.cancel`, the loop skips the model entirely and returns an assistant message with the
 * reason and stopReason endTurn, so a closed gate costs no Bedrock call. Each agent call runs
 * under the fiber's AbortSignal, so interrupting the fiber cancels the Bedrock request.
 *
 * Tests use stubs and a counting model; `scripts/probe-bedrock.ts` makes real calls. Set
 * EGGHEAD_MODEL_ID and AWS_REGION; auth is AWS_BEARER_TOKEN_BEDROCK (a Bedrock API key) or
 * the usual AWS credential chain.
 */
import {
  Agent,
  type BeforeModelCallEvent,
  BedrockModel,
  InterventionActions,
  InterventionHandler,
  type InvokableTool,
  tool
} from "@strands-agents/sdk"
import { Config, Context, Effect, Layer, Option, Ref } from "effect"
import { z } from "zod"
import { CHECKS, CheckSource, isCheck } from "./Checks.ts"
import type { LedgerItem } from "./Ledger.ts"
import type { Turn } from "./Questions.ts"
import { Escalator, ignore, type Route } from "./Router.ts"
import { SupportError, Writer } from "./Speaker.ts"

export const WRITER_PROMPT = "You are Egg Head, a quiet teammate on an incident bridge call. A claim someone made was " +
  "contradicted by a live check. Say it in ONE spoken sentence of at most 20 words. Start with 'Quick flag:', " +
  "address the person by name (no pronouns for them), and give the numbers from the evidence in plain spoken " +
  "words, without check names or code identifiers. No markdown. Never invent numbers. Call run_check only if " +
  "the evidence you were given is missing."

export const ESCALATE_PROMPT = "You help Egg Head decide which live check can verify the LATEST utterance on an " +
  "incident call. Pick the one check and the one resource, and the state the speaker " +
  "asserts. If it cannot be verified by any check, say it is not checkable."

export const RouteChoice = z.object({
  checkable: z.boolean(),
  check: z.string().nullish(),
  resource: z.string().nullish(),
  asserted: z.enum(["healthy", "degraded", "down", "changed", "unchanged", "unclear"]).nullish()
})
export type RouteChoice = z.infer<typeof RouteChoice>

/**
 * Closed gate => `deny`, so silence never reaches Bedrock.
 * `gateOpen` returns null when the gate is open, else the reason it is closed.
 */
export class SpeakGuard extends InterventionHandler {
  readonly name = "egghead-speak-guard"

  constructor(private readonly gateOpen: () => string | null) {
    super()
  }

  override beforeModelCall(_event: BeforeModelCallEvent) {
    const reason = this.gateOpen()
    return reason ? InterventionActions.deny(reason) : InterventionActions.proceed()
  }
}

export const checkTool = (source: CheckSource["Service"], run: <A>(effect: Effect.Effect<A>) => Promise<A>) =>
  tool({
    name: "run_check",
    description: "Run a live check. check is one of the registered checks, resource a known resource.",
    inputSchema: z.object({ check: z.string(), resource: z.string() }),
    callback: ({ check, resource }) =>
      run(Effect.map(source.run(check, resource), Option.match({
        onNone: () => `${check} does not apply to ${resource}`,
        onSome: (res) => `${res.check} on ${res.resource}: ${res.status}. ${res.evidence}`
      })))
  })

/** The slice of a Strands `Agent` Egg Head uses, so tests can stub it. */
export interface AgentLike {
  invoke(prompt: string, options?: {
    readonly structuredOutputSchema?: z.ZodType
    readonly cancelSignal?: AbortSignal
  }): Promise<{ toString(): string; readonly structuredOutput?: unknown }>
}

export interface AgentSpec {
  readonly systemPrompt: string
  readonly tools: Array<InvokableTool<any, any>>
  readonly interventions: Array<InterventionHandler>
}

export type AgentFactory = (spec: AgentSpec) => AgentLike

export const bedrockAgentFactory = (modelId: Option.Option<string>): AgentFactory => (spec) =>
  new Agent({
    model: new BedrockModel(Option.match(modelId, { onNone: () => ({}), onSome: (id) => ({ modelId: id }) })),
    systemPrompt: spec.systemPrompt,
    tools: spec.tools,
    interventions: spec.interventions,
    printer: false
  })

export interface SupportOptions {
  /** Injectable so tests need no AWS. Defaults to Bedrock with EGGHEAD_MODEL_ID. */
  readonly agentFactory?: AgentFactory | undefined
  readonly guard?: SpeakGuard | undefined
}

/** Writer and mid-band router. */
export class BedrockSupport extends Context.Service<BedrockSupport, {
  write(item: LedgerItem): Effect.Effect<string, SupportError>
  route(turns: ReadonlyArray<Turn>): Effect.Effect<Route, SupportError>
  readonly calls: Effect.Effect<{ readonly write: number; readonly route: number }>
}>()("egghead/Bedrock/BedrockSupport") {
  static readonly make = Effect.fnUntraced(function*(options: SupportOptions = {}) {
    const source = yield* CheckSource
    // Strands calls tools from Promise land: run them with this fiber's services and tracer.
    const run = Effect.runPromiseWith(yield* Effect.context<never>())
    const factory = options.agentFactory ??
      bedrockAgentFactory(yield* Config.option(Config.String("EGGHEAD_MODEL_ID")).pipe(Effect.orDie))
    const calls = yield* Ref.make({ write: 0, route: 0 })

    const invoke = (operation: "write" | "route", agent: AgentLike, prompt: string, schema?: z.ZodType) =>
      Ref.update(calls, (c) => ({ ...c, [operation]: c[operation] + 1 })).pipe(
        Effect.andThen(Effect.tryPromise({
          try: (signal) =>
            agent.invoke(prompt, schema ? { structuredOutputSchema: schema, cancelSignal: signal } : { cancelSignal: signal }),
          catch: (cause) => new SupportError({ operation, cause })
        }))
      )

    const write = Effect.fn("BedrockSupport.write")(function*(item: LedgerItem) {
      const agent = factory({
        systemPrompt: WRITER_PROMPT,
        tools: [checkTool(source, run)],
        interventions: options.guard ? [options.guard] : []
      })
      const prompt = `${item.speaker} said "${item.claim}". Check ${item.check} on ${item.resource} ` +
        `returned ${item.status}: ${item.evidence}.`
      const result = yield* invoke("write", agent, prompt)
      return String(result).trim()
    })

    const route = Effect.fn("BedrockSupport.route")(function*(turns: ReadonlyArray<Turn>) {
      const agent = factory({ systemPrompt: ESCALATE_PROMPT, tools: [], interventions: [] })
      const { resources, checks: byResource } = yield* source.inventory
      const known = Object.entries(resources)
        .map(([n, d]) => `- ${n}: ${d} (checks: ${(byResource[n] ?? []).join(", ")})`).join("\n")
      const checks = Object.entries(CHECKS).map(([n, d]) => `- ${n}: ${d}`).join("\n")
      const talk = turns.slice(-6).map(([s, t]) => `${s}: ${t}`).join("\n")
      const result = yield* invoke(
        "route",
        agent,
        `Checks:\n${checks}\n\nResources:\n${known}\n\nCall so far (last line is LATEST):\n${talk}`,
        RouteChoice
      )
      const parsed = RouteChoice.safeParse(result.structuredOutput)
      const choice = parsed.success ? parsed.data : undefined
      if (!(choice?.checkable && choice.check && isCheck(choice.check) && choice.resource &&
        Object.hasOwn(resources, choice.resource))) {
        return ignore
      }
      return {
        action: "check",
        check: Option.some(choice.check),
        resource: Option.some(choice.resource),
        asserted: Option.fromNullishOr(choice.asserted),
        scores: { bedrock: 1.0 }
      } satisfies Route
    })

    return BedrockSupport.of({ write, route, calls: Ref.get(calls) })
  })

  static readonly layer = (options?: SupportOptions) => Layer.effect(BedrockSupport, BedrockSupport.make(options))

  /** Writer and Escalator for the Bridge, both backed by one BedrockSupport. */
  static readonly bridgeServices = Layer.effectContext(
    Effect.map(BedrockSupport, (s) =>
      Context.make(Writer, Writer.of({ write: s.write })).pipe(
        Context.add(Escalator, Escalator.of({ route: s.route }))
      ))
  )
}
