import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Ref } from "effect"
import { Decision, DecisionModel } from "effect/ai"
import { HttpClient, HttpClientResponse } from "effect/http"
import { Schema } from "effect"
import {
  DEFAULT_USER_AGENT,
  layerHttp,
  PUBLIC_DECIDER_MODEL,
  LOCAL_DECIDER_URL,
  optionsFromEnv,
  PUBLIC_DECIDER_URL,
  ScriptedDecider
} from "../src/Decider.ts"

const withEnv = (env: Record<string, string>) => Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(env)))

describe("optionsFromEnv", () => {
  it.effect("defaults to the public API with a named user agent", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* optionsFromEnv, {
        url: PUBLIC_DECIDER_URL,
        model: PUBLIC_DECIDER_MODEL,
        userAgent: DEFAULT_USER_AGENT
      })
    }).pipe(withEnv({})))

  it.effect("points backend=http at the URL, or the local default", () =>
    Effect.gen(function*() {
      const custom = yield* optionsFromEnv.pipe(withEnv({ EGGHEAD_DECIDER_BACKEND: "http", EGGHEAD_DECIDER_URL: "http://example:9" }))
      assert.strictEqual(custom.url, "http://example:9")
      assert.strictEqual(custom.model, undefined) // a local serve gets no model unless asked
      const local = yield* optionsFromEnv.pipe(withEnv({ EGGHEAD_DECIDER_BACKEND: "HTTP", EGGHEAD_DECIDER_MODEL: "m" }))
      assert.deepStrictEqual([local.url, local.model], [LOCAL_DECIDER_URL, "m"])
    }))

  it.effect("explains how to run local weights instead of failing silently", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(optionsFromEnv)
      assert.strictEqual(error._tag, "LocalBackendUnavailable")
      assert.include(error._tag === "LocalBackendUnavailable" ? error.message : "", "strands-decider serve")
    }).pipe(withEnv({ EGGHEAD_DECIDER_BACKEND: "local" })))
})

const Triage = Decision.make({
  input: Schema.String,
  decisions: {
    claim: Decision.probability({ instructions: "Is it a claim?" }),
    check: Decision.classify({ instructions: "Which check?", criteria: { db: "database", none: "nothing" } })
  }
})

const okBody = {
  answers: {
    claim: { type: "noul", noul: 0.81 },
    check: { type: "choice", choice: "db", probabilities: { db: 0.7001, none: 0.3 }, confidence: 0.4 }
  },
  usage: { input_tokens: 120, output_tokens: 3 }
}

/** An HttpClient that records each request and answers with `respond`. */
const fakeHttp = (respond: (n: number) => { status: number; body: unknown }) =>
  Effect.gen(function*() {
    const seen = yield* Ref.make<Array<{ url: string; headers: Record<string, string>; body: unknown }>>([])
    const client = HttpClient.make((request, url) =>
      Effect.gen(function*() {
        const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined
        const n = (yield* Ref.updateAndGet(seen, (s) => [...s, { url: url.toString(), headers: { ...request.headers }, body }])).length
        const { status, body: out } = respond(n)
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(out), { status }))
      })
    )
    return { seen, layer: Layer.succeed(HttpClient.HttpClient, client) }
  })

describe("HTTP DecisionModel", () => {
  it.effect("posts state and questions to /v1/systemone with the user agent, and decodes answers", () =>
    Effect.gen(function*() {
      const http = yield* fakeHttp(() => ({ status: 200, body: okBody }))
      const { answers, usage } = yield* DecisionModel.decide(Triage, { input: "Sam: the DB is fine" }).pipe(
        Effect.provide(layerHttp({ url: "http://decider.test/", model: "strands-decider-2b" }).pipe(Layer.provide(http.layer)))
      )
      const [req] = yield* Ref.get(http.seen)
      assert.strictEqual(req!.url, "http://decider.test/v1/systemone")
      assert.strictEqual(req!.headers["user-agent"], DEFAULT_USER_AGENT)
      assert.deepStrictEqual(req!.body, {
        model: "strands-decider-2b",
        state: "Sam: the DB is fine",
        questions: {
          claim: { type: "noul", instructions: "Is it a claim?" },
          check: { type: "choice", instructions: "Which check?", criteria: { db: "database", none: "nothing" } }
        }
      })
      assert.strictEqual(answers.claim.probability, 0.81)
      assert.strictEqual(answers.check.label, "db")
      assert.strictEqual(answers.check.confidence, 0.4)
      // 4-decimal rounding drift is accepted and rescaled
      assert.closeTo(answers.check.probabilities.db + answers.check.probabilities.none, 1, 1e-12)
      assert.strictEqual(usage.inputTokens, 120)
    }))

  it.effect("answers a repeated request from cache", () =>
    Effect.gen(function*() {
      const http = yield* fakeHttp(() => ({ status: 200, body: okBody }))
      yield* Effect.gen(function*() {
        yield* DecisionModel.decide(Triage, { input: "same" })
        yield* DecisionModel.decide(Triage, { input: "same" })
        yield* DecisionModel.decide(Triage, { input: "other" })
      }).pipe(Effect.provide(layerHttp({ url: "http://decider.test" }).pipe(Layer.provide(http.layer))))
      assert.strictEqual((yield* Ref.get(http.seen)).length, 2)
    }))

  it.live("retries a transient 5xx, and does not cache failures", () =>
    Effect.gen(function*() {
      const http = yield* fakeHttp((n) => (n === 1 ? { status: 503, body: {} } : { status: 200, body: okBody }))
      const { answers } = yield* DecisionModel.decide(Triage, { input: "x" }).pipe(
        Effect.provide(layerHttp({ url: "http://decider.test" }).pipe(Layer.provide(http.layer)))
      )
      assert.strictEqual(answers.check.label, "db")
      assert.strictEqual((yield* Ref.get(http.seen)).length, 2)
    }))

  it.effect("splits a batch over 8 questions into several requests", () =>
    Effect.gen(function*() {
      const http = yield* fakeHttp(() => ({ status: 200, body: okBody }))
      const many = Decision.make({
        input: Schema.String,
        decisions: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`claim${i}`, Decision.probability({ instructions: "?" })]))
      })
      const reply = (n: number) => ({
        status: 200,
        body: { answers: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`claim${i}`, { type: "noul", noul: n / 10 }])) }
      })
      const split = yield* fakeHttp(reply)
      const { answers } = yield* DecisionModel.decide(many, { input: "x" }).pipe(
        Effect.provide(layerHttp({ url: "http://decider.test" }).pipe(Layer.provide(split.layer)))
      )
      const sent = (yield* Ref.get(split.seen)).map((r) => Object.keys((r.body as { questions: object }).questions).length)
      assert.deepStrictEqual(sent, [8, 2])
      assert.deepStrictEqual([answers.claim0?.probability, answers.claim9?.probability], [0.1, 0.2])
      assert.strictEqual((yield* Ref.get(http.seen)).length, 0)
    }))

  it.effect("maps a 4xx to an AiError that carries the server's explanation", () =>
    Effect.gen(function*() {
      const body = { error: { code: "invalid_request", fields: [{ location: ["body", "model"], type: "missing" }] } }
      const http = yield* fakeHttp(() => ({ status: 422, body }))
      const error = yield* DecisionModel.decide(Triage, { input: "x" }).pipe(
        Effect.provide(layerHttp({ url: "http://decider.test" }).pipe(Layer.provide(http.layer))),
        Effect.flip
      )
      assert.include(error.message, '"location":["body","model"]')
      assert.strictEqual((yield* Ref.get(http.seen)).length, 1) // 4xx is not retried
    }))
})

describe("ScriptedDecider", () => {
  it.effect("answers only what was asked, and records each request", () =>
    Effect.gen(function*() {
      const { answers } = yield* DecisionModel.decide(
        Decision.make({ input: Schema.String, decisions: { claim: Decision.probability({ instructions: "?" }) } }),
        { input: "s" }
      )
      assert.strictEqual(answers.claim.probability, 0.5)
      const [call] = yield* (yield* ScriptedDecider).calls
      assert.deepStrictEqual(Object.keys(call!.questions), ["claim"])
    }).pipe(Effect.provide(ScriptedDecider.layer([{ claim: { type: "noul", noul: 0.5 }, extra: { type: "noul", noul: 1 } }]))))
})
