/**
 * Demo dashboard: http://localhost:8787. Press Start (or pass --autostart) to play the call.
 *
 *   npm run demo                               # text mode, template writer (no Bedrock, no Transcribe)
 *   npm run demo -- --writer bedrock           # Bedrock writes Egg Head's line and routes escalations
 *   npm run demo -- --mode transcribe          # Amazon Transcribe hears the call audio
 *   npm run demo -- --call data/calls/x.json --port 8080
 *
 * Needs AWS credentials for Polly (and Transcribe in that mode), and Bedrock for --writer
 * bedrock: `npm run demo` loads .env (AWS_BEARER_TOKEN_BEDROCK, EGGHEAD_MODEL_ID, AWS_REGION).
 * Every run's messages are saved to demo/out/runs/<time>.json.
 */
import { Console, Duration, Effect, Layer, Schema } from "effect"
import { Decision, DecisionModel } from "effect/ai"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { parseArgs } from "node:util"
import { BedrockSupport } from "../src/Bedrock.ts"
import { Bridge } from "../src/Bridge.ts"
import { MockSource } from "../src/Checks.ts"
import * as Decider from "../src/Decider.ts"
import { Writer } from "../src/Speaker.ts"
import { Call, DeciderMeter, Floor, type Message, run } from "./Run.ts"
import { Voice } from "./Voice.ts"

const { values: args } = parseArgs({
  options: {
    mode: { type: "string", default: "text" },
    writer: { type: "string", default: "template" },
    call: { type: "string", default: "data/calls/checkout-incident.json" },
    port: { type: "string", default: "8787" },
    autostart: { type: "boolean", default: false }
  }
})
const mode = args.mode === "transcribe" ? "transcribe" : "text"
const writer = args.writer === "bedrock" ? "bedrock" : "template"
const call = Schema.decodeUnknownSync(Call)(JSON.parse(readFileSync(args.call!, "utf8")))
const page = new URL("./index.html", import.meta.url) // read per request, so edits show on reload
const AUDIO = new URL("./out/audio/", import.meta.url)
const RUNS = new URL("./out/runs/", import.meta.url)

const history: Array<Message> = []
const clients = new Set<ServerResponse>()
const publish = (m: Message) =>
  Effect.sync(() => {
    history.push(m)
    const data = `data: ${JSON.stringify(m)}\n\n`
    for (const c of clients) c.write(data)
  })

// One run = fresh Bridge, ledger, Decider cache and Bedrock counters.
const runLayer = () => {
  const decider = DeciderMeter.layer.pipe(Layer.provide(Decider.layerFromEnv))
  const source = MockSource.layer()
  const support = writer === "bedrock"
    ? BedrockSupport.bridgeServices.pipe(Layer.provideMerge(BedrockSupport.layer()), Layer.provide(source))
    : Writer.template
  const writing = Layer.provideMerge(Floor.holdWhileWriting, Layer.merge(support, Floor.layer))
  return Bridge.layer.pipe(Layer.provideMerge(Layer.mergeAll(decider, source, writing, Voice.layer)))
}

let running = false
const start = () => {
  if (running) return
  running = true
  history.length = 0
  for (const c of clients) c.write(`data: ${JSON.stringify({ type: "reset" })}\n\n`)
  const program = Effect.gen(function*() {
    const support = yield* Effect.serviceOption(BedrockSupport)
    const bedrockCalls = support._tag === "Some"
      ? Effect.map(support.value.calls, (c) => c.write + c.route)
      : Effect.succeed(0)
    const state = yield* run(call, { mode, writer, bedrockCalls, publish })
    yield* Console.log(`done: ${state.events.filter((e) => e.said._tag === "Some").length} spoken, ${state.escalations} escalations`)
  }).pipe(Effect.scoped, Effect.provide(runLayer()))
  Effect.runPromise(program)
    .catch((e) => {
      console.error(e)
      return Effect.runPromise(publish({ type: "done" }))
    })
    .finally(() => {
      running = false
      mkdirSync(RUNS, { recursive: true })
      writeFileSync(new URL(`${new Date().toISOString().replace(/[:.]/g, "-")}.json`, RUNS), JSON.stringify({ mode, writer, call: args.call, history }, null, 1))
    })
}

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(page))
  } else if (url.pathname === "/history") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(history))
  } else if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    for (const m of history) res.write(`data: ${JSON.stringify(m)}\n\n`)
    clients.add(res)
    req.on("close", () => clients.delete(res))
  } else if (url.pathname.startsWith("/audio/") && /^\/audio\/[0-9a-f]{16}\.wav$/.test(url.pathname)) {
    try {
      res.writeHead(200, { "content-type": "audio/wav" }).end(readFileSync(new URL(url.pathname.slice(7), AUDIO)))
    } catch {
      res.writeHead(404).end()
    }
  } else if (url.pathname === "/start" && req.method === "POST") {
    start()
    res.writeHead(204).end()
  } else {
    res.writeHead(404).end()
  }
}).listen(Number(args.port), () => {
  console.log(`Egg Head demo: http://localhost:${args.port}  (mode ${mode}, writer ${writer})`)
  // The hosted Decider runs on serverless GPUs: the first request after a while can take ~30 s.
  const warm = DecisionModel.decide(
    Decision.make({ input: Schema.String, decisions: { ok: Decision.probability({ instructions: "Is this a warm-up?" }) } }),
    { input: "warm-up" }
  )
  Effect.runPromise(Effect.timed(warm).pipe(Effect.provide(Decider.layerFromEnv)))
    .then(([d]) => console.log(`Decider warm (${Math.round(Duration.toMillis(d))} ms)`), (e) => console.error("Decider warm-up failed", e))
    .finally(() => args.autostart && start())
})

