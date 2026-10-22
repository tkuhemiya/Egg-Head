/**
 * Strands Decider 2B as an Effect `DecisionModel` provider.
 *
 * Decider's `/v1/systemone` call and `effect/ai/DecisionModel` have the same shape: one state,
 * named questions, one call. `noul` is `Decision.probability`, `choice` is `Decision.classify`
 * and `score` is `Decision.rate`. Every backend (the hosted API, a `strands-decider serve`,
 * scripted answers for tests) goes through the same translation and the same answer
 * validation, so a test replay exercises the exact path a live call takes.
 *
 * In-process weights (the old Python `LocalDecider`) have no JavaScript runtime: run
 * `strands-decider serve` and point `EGGHEAD_DECIDER_BACKEND=http` at it.
 */
import { Cache, Config, Context, Duration, Effect, Exit, Layer, Option, Redactable, Ref, Schedule, Schema } from "effect"
import { AiError, DecisionModel } from "effect/ai"
import type { Decision } from "effect/ai"
import type { HttpClientError } from "effect/http"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

export const PUBLIC_DECIDER_URL = "https://api.decider.cloud"
export const LOCAL_DECIDER_URL = "http://127.0.0.1:8000"
// The hosted API requires a model id in the body (since 22 Oct 2026; 422 without it).
export const PUBLIC_DECIDER_MODEL = "strands-decider-2b"
// The hosted API answers Node's and Python's default user agents with 403, so always name ours.
export const DEFAULT_USER_AGENT = "egghead-decider-client/1.0 (+https://github.com/tkuhemiya/Egg-Head)"
// Decider rounds every probability to 4 decimals.
const PROBABILITY_PRECISION = 4

// ---------------------------------------------------------------------------
// Wire format of POST /v1/systemone
// ---------------------------------------------------------------------------

const Probabilities = Schema.Record(Schema.String, Schema.Number)

export const SystemOneAnswer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.String,
    probabilities: Probabilities,
    confidence: Schema.optional(Schema.Number)
  }),
  Schema.Struct({
    type: Schema.Literal("score"),
    score: Schema.Number,
    probabilities: Probabilities, // keyed by level index: "0", "1", ...
    confidence: Schema.optional(Schema.Number)
  })
])
export type SystemOneAnswer = typeof SystemOneAnswer.Type

export const SystemOneResponse = Schema.Struct({
  answers: Schema.Record(Schema.String, SystemOneAnswer),
  usage: Schema.optional(Schema.Struct({
    input_tokens: Schema.optional(Schema.Number),
    output_tokens: Schema.optional(Schema.Number)
  }))
})
export type SystemOneResponse = typeof SystemOneResponse.Type

export type SystemOneQuestion =
  | { readonly type: "noul"; readonly instructions: Decision.Description; readonly criteria?: object }
  | { readonly type: "choice"; readonly instructions: Decision.Description; readonly criteria: object }
  | { readonly type: "score"; readonly instructions: Decision.Description; readonly criteria: ReadonlyArray<Decision.Description> }

export interface SystemOneRequest {
  readonly state: Schema.Json
  readonly questions: Readonly<Record<string, SystemOneQuestion>>
}

/** Effect decisions -> Decider questions. Key order is kept: it is the option order. */
export const encodeQuestions = (decisions: Readonly<Record<string, Decision.Any>>): Record<string, SystemOneQuestion> => {
  const questions: Record<string, SystemOneQuestion> = {}
  for (const [key, d] of Object.entries(decisions)) {
    switch (d._tag) {
      case "Probability":
        questions[key] = d.criteria === undefined
          ? { type: "noul", instructions: d.instructions }
          : { type: "noul", instructions: d.instructions, criteria: d.criteria }
        break
      case "Classify":
        questions[key] = { type: "choice", instructions: d.instructions, criteria: d.criteria }
        break
      case "Rate":
        questions[key] = { type: "score", instructions: d.instructions, criteria: d.criteria.map((l) => l.description) }
        break
    }
  }
  return questions
}

/** Decider answers -> provider answers. Missing answers stay missing so validation reports them. */
export const decodeAnswers = (
  decisions: Readonly<Record<string, Decision.Any>>,
  answers: Readonly<Record<string, SystemOneAnswer>>
): Record<string, DecisionModel.ProviderAnswer> => {
  const out: Record<string, DecisionModel.ProviderAnswer> = {}
  for (const [key, d] of Object.entries(decisions)) {
    const a = answers[key]
    switch (a?.type) {
      case "noul":
        out[key] = { _tag: "Probability", probability: a.noul }
        break
      case "choice":
        out[key] = { _tag: "Classify", label: a.choice, probabilities: a.probabilities, confidence: a.confidence }
        break
      case "score": {
        const levels = d._tag === "Rate" ? d.criteria : []
        const probabilities: Record<string, number> = {}
        levels.forEach((level, i) => {
          const p = a.probabilities[String(i)]
          if (p !== undefined) probabilities[level.label] = p
        })
        out[key] = { _tag: "Rate", rating: a.score, probabilities, confidence: a.confidence }
        break
      }
    }
  }
  return out
}

/** A `DecisionModel` over any function that answers one systemone request. */
export const make = (systemOne: (request: SystemOneRequest) => Effect.Effect<SystemOneResponse, AiError.AiError>) =>
  DecisionModel.make({
    probabilityPrecision: PROBABILITY_PRECISION,
    decide: ({ state, decisions }) =>
      Effect.map(systemOne({ state, questions: encodeQuestions(decisions) }), (response) => ({
        answers: decodeAnswers(decisions, response.answers),
        usage: { inputTokens: response.usage?.input_tokens, outputTokens: response.usage?.output_tokens }
      }))
  })

// ---------------------------------------------------------------------------
// HTTP backend
// ---------------------------------------------------------------------------

export interface HttpOptions {
  readonly url: string
  /** Sent as `model` in the body when set. Required by the hosted API. */
  readonly model?: string | undefined
  readonly userAgent?: string | undefined
  /** Per request. A CPU `strands-decider serve` can take tens of seconds per batch. */
  readonly timeout?: Duration.Input | undefined
  /** Identical requests are answered from memory (the hosted API is best effort). */
  readonly cacheCapacity?: number | undefined
}

const deciderError = (reason: AiError.AiErrorReason) => AiError.make({ module: "StrandsDecider", method: "systemOne", reason })

const requestDetails = (request: HttpClientRequest.HttpClientRequest) => ({
  method: request.method,
  url: request.url,
  urlParams: Array.from(request.urlParams),
  headers: Redactable.redact(request.headers) as Record<string, string>
})

const mapHttpError = (error: HttpClientError.HttpClientError): Effect.Effect<never, AiError.AiError> => {
  const source = error.reason
  switch (source._tag) {
    case "StatusCodeError":
      // Keep the body: on a 422 it is the only thing that says which field was rejected.
      return source.response.text.pipe(
        Effect.orElseSucceed(() => ""),
        Effect.flatMap((body) =>
          Effect.fail(deciderError(AiError.reasonFromHttpStatus({
            status: source.response.status,
            body,
            description: `Decider answered HTTP ${source.response.status} for ${source.request.url}: ${body.slice(0, 500)}`
          })))
        )
      )
    case "DecodeError":
    case "EmptyBodyError":
      return Effect.fail(deciderError(new AiError.InvalidOutputError({ description: source.description ?? source._tag })))
    case "TransportError":
    case "EncodeError":
    case "InvalidUrlError":
      return Effect.fail(deciderError(new AiError.NetworkError({
        reason: source._tag,
        description: source.description,
        request: requestDetails(source.request)
      })))
  }
}

export const makeHttp = Effect.fnUntraced(function*(options: HttpOptions) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(options.url.replace(/\/+$/, "")),
        HttpClientRequest.setHeader("user-agent", options.userAgent ?? DEFAULT_USER_AGENT),
        HttpClientRequest.acceptJson
      )
    ),
    HttpClient.filterStatusOk,
    HttpClient.retryTransient({ schedule: Schedule.exponential("200 millis"), times: 3 })
  )
  const post = (body: string) =>
    HttpClientRequest.post("/v1/systemone").pipe(
      HttpClientRequest.bodyText(body, "application/json"),
      client.execute,
      Effect.flatMap(HttpClientResponse.schemaBodyJson(SystemOneResponse)),
      Effect.timeout(options.timeout ?? "300 seconds"),
      Effect.catchTags({
        HttpClientError: mapHttpError,
        SchemaError: (e) => Effect.fail(deciderError(AiError.InvalidOutputError.fromSchemaError(e))),
        TimeoutError: () => Effect.fail(deciderError(new AiError.UnknownError({ description: "Decider request timed out" })))
      })
    )
  const cache = yield* Cache.makeWith(post, {
    capacity: options.cacheCapacity ?? 512,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero)
  })
  return yield* make((request) =>
    Cache.get(cache, JSON.stringify(options.model === undefined ? request : { model: options.model, ...request }))
  )
})

/** DecisionModel over HTTP. Needs an `HttpClient` (see `layerFetch`). */
export const layerHttp = (options: HttpOptions) => Layer.effect(DecisionModel.DecisionModel, makeHttp(options))

/** DecisionModel over HTTP with the platform `fetch`. */
export const layerFetch = (options: HttpOptions) => layerHttp(options).pipe(Layer.provide(FetchHttpClient.layer))

// ---------------------------------------------------------------------------
// Wiring from the environment (see AGENTS.md)
// ---------------------------------------------------------------------------

export class LocalBackendUnavailable extends Schema.TaggedError<LocalBackendUnavailable>()("LocalBackendUnavailable", {
  message: Schema.String
}) {}

/**
 * EGGHEAD_DECIDER_BACKEND:
 *   public | hosted  free API at api.decider.cloud (default when unset), model strands-decider-2b
 *   http             strands-decider serve base URL (EGGHEAD_DECIDER_URL or :8000); sends
 *                    EGGHEAD_DECIDER_MODEL as `model` only when it is set
 *   local            not available in TypeScript; fails with how to run `serve` instead
 */
export const optionsFromEnv = Effect.gen(function*() {
  const backend = (yield* Config.String("EGGHEAD_DECIDER_BACKEND").pipe(Config.withDefault("public")))
    .trim().toLowerCase()
  const userAgent = yield* Config.String("EGGHEAD_DECIDER_USER_AGENT").pipe(Config.withDefault(DEFAULT_USER_AGENT))
  if (backend === "public" || backend === "hosted") {
    return { url: PUBLIC_DECIDER_URL, model: PUBLIC_DECIDER_MODEL, userAgent } satisfies HttpOptions
  }
  if (backend === "http") {
    const url = yield* Config.String("EGGHEAD_DECIDER_URL").pipe(Config.withDefault(LOCAL_DECIDER_URL))
    const model = yield* Config.option(Config.String("EGGHEAD_DECIDER_MODEL"))
    return { url, model: Option.getOrUndefined(model), userAgent } satisfies HttpOptions
  }
  if (backend === "local") {
    return yield* new LocalBackendUnavailable({
      message: "In-process Decider weights need Python. Run `strands-decider serve " +
        "StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 --port 8000` and set EGGHEAD_DECIDER_BACKEND=http."
    })
  }
  return yield* Effect.die(new Error(`unknown EGGHEAD_DECIDER_BACKEND: ${backend}`))
})

/** Production wiring: `Bridge` over `layerFromEnv` (tests use `ScriptedDecider.layer`). */
export const layerFromEnv = Layer.unwrap(Effect.map(optionsFromEnv, layerFetch))

// ---------------------------------------------------------------------------
// Scripted backend (tests and demo runs that must not vary)
// ---------------------------------------------------------------------------

/**
 * Replays prepared Decider answers in order, one batch per call. Like a real server it
 * answers only the questions that were asked, so a script can carry extra answers.
 * `layer` provides both this service (to inspect the requests) and the DecisionModel.
 */
export class ScriptedDecider extends Context.Service<ScriptedDecider, {
  /** Every request the model received, in order. */
  readonly calls: Effect.Effect<ReadonlyArray<SystemOneRequest>>
}>()("egghead/Decider/ScriptedDecider") {
  static readonly layer = (batches: ReadonlyArray<Readonly<Record<string, SystemOneAnswer>>>) =>
    Layer.effectContext(Effect.gen(function*() {
      const queue = yield* Ref.make(batches)
      const calls = yield* Ref.make<ReadonlyArray<SystemOneRequest>>([])
      const answer = (request: SystemOneRequest) =>
        Ref.update(calls, (cs) => [...cs, request]).pipe(
          Effect.andThen(Ref.modify(queue, ([head, ...rest]) => [head, rest] as const)),
          Effect.flatMap((batch) =>
            batch === undefined
              ? Effect.fail(deciderError(new AiError.InvalidOutputError({ description: "scripted Decider ran out of answers" })))
              : Effect.succeed({
                answers: Object.fromEntries(
                  Object.keys(request.questions).flatMap((key) => (batch[key] ? [[key, batch[key]] as const] : []))
                )
              })
          )
        )
      const model = yield* make(answer)
      return Context.make(DecisionModel.DecisionModel, model).pipe(
        Context.add(ScriptedDecider, ScriptedDecider.of({ calls: Ref.get(calls) }))
      )
    }))
}
