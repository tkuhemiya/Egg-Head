/**
 * The demo: a meeting page at http://localhost:8787 (cartoon teammates, your camera, Egg Head,
 * and the coding agent's live terminal) and a dashboard at /dashboard (transcript, checks,
 * what triggered what). Press Start on either page to play the call.
 *
 *   npm run demo                               # Decider + pi on Bedrock in the terminal + Polly voices
 *   npm run demo -- --rehearsal                # no network: scripted Decider and pi model, silent voices
 *   npm run demo -- --agent none               # no terminal agent: Egg Head speaks from the fast checks
 *   npm run demo -- --agent-cmd "claude" --agent-env ANTHROPIC_API_KEY   # any other terminal agent (it sees only the variables named)
 *   npm run demo -- --agent-model qwen.qwen3-coder-30b-a3b-v1:0
 *   npm run demo -- --writer bedrock           # Bedrock routes claims Decider could not (escalations)
 *   npm run demo -- --mode transcribe          # Amazon Transcribe hears the call audio
 *   npm run demo -- --call data/calls/x.json --port 8080 --autostart   # --host 0.0.0.0 to serve other machines
 *
 * Needs AWS credentials for Polly (and Transcribe in that mode), and Bedrock for pi and
 * --writer bedrock: `npm run demo` loads .env (AWS_BEARER_TOKEN_BEDROCK, EGGHEAD_MODEL_ID,
 * AWS_REGION). Every run is saved to demo/out/runs/<time>.json with the scenario it played, and
 * scored against the scenario's expectations (`npx tsx scripts/check-run.ts latest` for the table).
 */
import { randomUUID } from "node:crypto"
import { Console, Duration, Effect, Layer, ManagedRuntime, Result, Schema } from "effect"
import { Decision, DecisionModel } from "effect/ai"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { parseArgs } from "node:util"
import { BedrockSupport } from "../src/runtime/Bedrock.ts"
import { Bridge } from "../src/runtime/Bridge.ts"
import { Call, decodeCallSync, encodeLogged, Hold, type Logged } from "../src/runtime/Call.ts"
import { MockSource } from "../src/domain/Checks.ts"
import * as Decider from "../src/runtime/Decider.ts"
import { hinted } from "../src/runtime/Hints.ts"
import { judge, LIVE, render } from "../src/runtime/Judge.ts"
import { Writer } from "../src/domain/Speaker.ts"
import { AgentTerminal, customOptions, piOptions } from "./Agent.ts"
import { DeciderMeter, type PageOnly, run } from "./Run.ts"
import { rehearsalVoice, Voice, voiceSound } from "./Voice.ts"

const { values: args } = parseArgs({
  options: {
    mode: { type: "string", default: "text" },
    writer: { type: "string", default: "template" },
    agent: { type: "string", default: "pi" },
    "agent-cmd": { type: "string" },
    "agent-model": { type: "string" },
    "agent-timeout": { type: "string", default: "60" },
    "agent-env": { type: "string", default: "" },
    rehearsal: { type: "boolean", default: false },
    call: { type: "string", default: "data/calls/checkout-incident.json" },
    port: { type: "string", default: "8787" },
    host: { type: "string", default: "127.0.0.1" },
    autostart: { type: "boolean", default: false }
  }
})
const rehearsal = args.rehearsal!
const mode = args.mode === "transcribe" && !rehearsal ? "transcribe" : "text"
const writer = args.writer === "bedrock" && !rehearsal ? "bedrock" : "template"
const call = decodeCallSync(JSON.parse(readFileSync(args.call!, "utf8")))
const deciderBackend = process.env.EGGHEAD_DECIDER_BACKEND ?? "public"
const port = Number(args.port)
const WEB = new URL("./web/", import.meta.url) // read per request, so edits show on reload
const VENDOR: Readonly<Record<string, string>> = {
  "xterm.js": "../node_modules/@xterm/xterm/lib/xterm.js",
  "xterm.css": "../node_modules/@xterm/xterm/css/xterm.css",
  "addon-fit.js": "../node_modules/@xterm/addon-fit/lib/addon-fit.js"
}
const AUDIO = new URL("./out/audio/", import.meta.url)
const RUNS = new URL("./out/runs/", import.meta.url)

// The terminal agent lives as long as the server, so the page shows it before and between runs.
// Only the agent's `egghead` command knows this key, so nothing else can put words in Egg Head's mouth.
const reportKey = randomUUID()
const reportUrl = `http://127.0.0.1:${port}/agent/report?key=${reportKey}`
const timeoutS = Number(args["agent-timeout"])
const agentOptions = args["agent-cmd"]
  ? customOptions(args["agent-cmd"], reportUrl, timeoutS, args["agent-env"]!.split(",").filter(Boolean))
  : args.agent === "pi"
  ? piOptions({
    model: args["agent-model"] ?? process.env.EGGHEAD_AGENT_MODEL ?? process.env.EGGHEAD_MODEL_ID ?? "nvidia.nemotron-nano-3-30b",
    rehearsal,
    reportUrl,
    timeoutS
  })
  : undefined
const agentRuntime = agentOptions ? ManagedRuntime.make(AgentTerminal.layer(agentOptions)) : undefined
const agent = agentRuntime ? await agentRuntime.runPromise(Effect.gen(function*() {
  return yield* AgentTerminal
})) : undefined
const agentLabel = agent?.label ?? "none"

const history: Array<unknown> = [] // as sent to the pages; `at`: ms since the run started
const log: Array<Logged> = [] // what the Judge reads
const clients = new Set<ServerResponse>()
let runStarted = 0
const publish = (m: Logged | PageOnly) =>
  Effect.sync(() => {
    if ("at" in m) log.push(m)
    const stamped = "at" in m ? encodeLogged(m) : { ...m, at: Date.now() - runStarted }
    history.push(stamped)
    const data = `data: ${JSON.stringify(stamped)}\n\n`
    for (const c of clients) c.write(data)
  })

// Rehearsals answer from each line's hints, with about the hosted API's latency.
const deciderLayer = rehearsal ? hinted(call.lines, { latencyMs: 200 }) : Decider.layerFromEnv

// One run = fresh Bridge, ledger, Decider cache and Bedrock counters (the terminal agent stays).
const runLayer = () => {
  const decider = DeciderMeter.layer.pipe(Layer.provide(deciderLayer))
  const source = MockSource.layer()
  const support = writer === "bedrock"
    ? BedrockSupport.bridgeServices.pipe(Layer.provideMerge(BedrockSupport.layer()), Layer.provide(source))
    : Writer.template
  const writing = Layer.provideMerge(Hold.whileWriting, Layer.merge(support, Hold.layer))
  const investigator = agent ? AgentTerminal.investigator.pipe(Layer.provide(Layer.succeed(AgentTerminal, agent))) : Layer.empty
  return Bridge.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(decider, source, writing, Layer.provideMerge(voiceSound, rehearsal ? rehearsalVoice : Voice.layer), investigator))
  )
}

/** One uncached Decider request (the hosted API sleeps when idle; this wakes it). */
const warmUp = DecisionModel.decide(
  Decision.make({ input: Schema.String, decisions: { ok: Decision.probability({ instructions: "Is this a warm-up?" }) } }),
  { input: `warm-up ${Date.now()}` }
).pipe(Effect.provide(deciderLayer), Effect.orDie)

let running = false
const start = () => {
  if (running) return
  running = true
  runStarted = Date.now()
  history.length = 0
  log.length = 0
  for (const c of clients) c.write(`data: ${JSON.stringify({ type: "reset" })}\n\n`)
  const program = Effect.gen(function*() {
    // The hosted Decider sleeps when idle and the first request then takes ~15-30 s. Wake it
    // before the call starts, or every decision lags the audio and the script's order breaks.
    yield* publish({ type: "status", text: rehearsal ? "Rehearsal: scripted Decider" : "Waking up Decider…" })
    const [woke] = yield* Effect.timed(warmUp)
    yield* publish({ type: "status", text: `Decider ready (${Math.round(Duration.toMillis(woke))} ms)` })
    const support = yield* Effect.serviceOption(BedrockSupport)
    const bedrockCalls = support._tag === "Some"
      ? Effect.map(support.value.calls, (c) => c.write + c.route)
      : Effect.succeed(0)
    const state = yield* run(call, { mode, writer, agent: agentLabel, originMs: runStarted, bedrockCalls, publish })
    yield* Console.log(`done: ${state.events.filter((e) => e.said._tag === "Some").length} spoken, ${state.tasks} agent tasks, ${state.escalations} escalations`)
  }).pipe(Effect.scoped, Effect.provide(runLayer()))
  Effect.runPromise(program)
    .catch((e) => {
      console.error(e)
      return Effect.runPromise(publish({ type: "done", at: Date.now() - runStarted }))
    })
    .finally(() => {
      running = false
      mkdirSync(RUNS, { recursive: true })
      const record = {
        scenario: Schema.encodeSync(Call)(call),
        run: { startedAt: new Date(runStarted).toISOString(), decider: rehearsal ? "hints" : deciderBackend, mode, writer, agent: agentLabel, rehearsal, call: args.call },
        log: history
      }
      writeFileSync(new URL(`${new Date().toISOString().replace(/[:.]/g, "-")}.json`, RUNS), JSON.stringify(record, null, 1))
      const scored = judge(call, log, LIVE)
      console.log(Result.isSuccess(scored)
        ? `${render(scored.success, { onlyFailures: true })}\n(npx tsx scripts/check-run.ts latest for every line)`
        : `could not score the run: line ${scored.failure.index} was "${scored.failure.recorded}"`)
    })
}

const MAX_BODY = 64 * 1024

/** A JSON body (or undefined). Requiring JSON makes a cross-site form or no-cors fetch fail its preflight. */
const body = (req: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return resolve(undefined)
    let raw = ""
    req.on("data", (d) => {
      raw += d
      if (raw.length > MAX_BODY) req.destroy()
    })
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(undefined)
      }
    })
  })

const sse = (res: ServerResponse) =>
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })

const TYPES: Readonly<Record<string, string>> = { html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css", svg: "image/svg+xml" }

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  const page = ({ "/": "meeting.html", "/dashboard": "dashboard.html" } as Record<string, string>)[url.pathname]
  if (page) {
    res.writeHead(200, { "content-type": TYPES.html! }).end(readFileSync(new URL(page, WEB)))
  } else if (/^\/web\/[\w-]+\.(js|css|svg)$/.test(url.pathname)) {
    const file = new URL(url.pathname.slice(5), WEB)
    if (!existsSync(file)) return void res.writeHead(404).end()
    res.writeHead(200, { "content-type": TYPES[url.pathname.split(".").pop()!]! }).end(readFileSync(file))
  } else if (url.pathname.startsWith("/vendor/") && VENDOR[url.pathname.slice(8)]) {
    const name = url.pathname.slice(8)
    res.writeHead(200, { "content-type": TYPES[name.split(".").pop()!]! }).end(readFileSync(new URL(VENDOR[name]!, import.meta.url)))
  } else if (url.pathname === "/config") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ title: call.title, agent: agentLabel, rehearsal, mode, writer, people: [...new Set(call.lines.map((l) => l.speaker))] }))
  } else if (url.pathname === "/history") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(history))
  } else if (url.pathname === "/events") {
    sse(res)
    for (const m of history) res.write(`data: ${JSON.stringify(m)}\n\n`)
    clients.add(res)
    req.on("close", () => clients.delete(res))
  } else if (url.pathname === "/pty") {
    sse(res)
    if (!agent) return void res.write(`data: ${JSON.stringify({ d: "No terminal agent in this run (--agent none).\r\n" })}\n\n`)
    res.write(`data: ${JSON.stringify({ d: agent.scrollback() })}\n\n`)
    const off = agent.subscribe((d) => res.write(`data: ${JSON.stringify({ d })}\n\n`))
    req.on("close", off)
  } else if (url.pathname === "/pty/resize" && req.method === "POST") {
    void body(req).then((b) => {
      const { cols, rows } = (b ?? {}) as { cols?: number; rows?: number }
      if (agent && typeof cols === "number" && typeof rows === "number") agent.resize(cols, rows)
      res.writeHead(204).end()
    })
  } else if (url.pathname === "/agent/report" && req.method === "POST") {
    if (url.searchParams.get("key") !== reportKey) return void res.writeHead(403).end()
    void body(req).then(async (b) => {
      const taken = agent ? await Effect.runPromise(agent.report(b)) : false
      res.writeHead(taken ? 200 : 404, { "content-type": "text/plain" }).end(taken ? "ok" : "no job is waiting for that task")
    })
  } else if (url.pathname.startsWith("/audio/") && /^\/audio\/[0-9a-f]{16}\.wav$/.test(url.pathname)) {
    try {
      res.writeHead(200, { "content-type": "audio/wav" }).end(readFileSync(new URL(url.pathname.slice(7), AUDIO)))
    } catch {
      res.writeHead(404).end()
    }
  } else if (url.pathname === "/start" && req.method === "POST") {
    void body(req).then((b) => {
      if (b === undefined) return void res.writeHead(415).end()
      start()
      res.writeHead(204).end()
    })
  } else {
    res.writeHead(404).end()
  }
}).listen(port, args.host, () => {
  console.log(`Egg Head demo: http://${args.host === "127.0.0.1" ? "localhost" : args.host}:${port}  (dashboard /dashboard; mode ${mode}, agent ${agentLabel}${rehearsal ? ", REHEARSAL" : ""})`)
  Effect.runPromise(Effect.timed(warmUp))
    .then(([d]) => console.log(`Decider warm (${Math.round(Duration.toMillis(d))} ms)`), (e) => console.error("Decider warm-up failed", e))
    .finally(() => args.autostart && start())
})

process.on("SIGINT", () => {
  void agentRuntime?.dispose().finally(() => process.exit(0))
  if (!agentRuntime) process.exit(0)
})
