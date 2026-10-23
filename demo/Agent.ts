/**
 * The demo's Investigator: a coding agent in a real terminal (a pseudo-terminal, node-pty),
 * shown live on the dashboard. Egg Head types each job into the agent's prompt the way a
 * person would, and the agent hands its result back by running `egghead report|answer`
 * (demo/agent/bin/egghead -> POST /agent/report). Any terminal agent that can run shell
 * commands works; the default is pi on Amazon Bedrock.
 *
 * The agent's shell has the stand-in AWS CLI first on PATH (demo/agent/bin/aws), which answers
 * from data/aws.json. Open jobs share one prompt (oldest task first); the agent reports each
 * id with `egghead report|answer <task>`. A timeout or a crash falls back to the direct check
 * (Investigator.direct).
 */
import { Context, Deferred, Duration, Effect, Layer, Option, Queue, Ref, Schema } from "effect"
import { chmodSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as pty from "node-pty"
import { Investigator } from "../src/runtime/Investigator.ts"
import type { LedgerItem } from "../src/domain/Ledger.ts"
import { SupportError } from "../src/domain/Speaker.ts"
import { Status } from "../src/domain/Checks.ts"

/** npm can drop the execute bit on node-pty's spawn-helper; posix_spawnp then fails on macOS. */
const chmodPtyHelpers = () => {
  const root = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"))
  for (const plat of readdirSync(join(root, "prebuilds"))) {
    const helper = join(root, "prebuilds", plat, "spawn-helper")
    try {
      if ((statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755)
    } catch { /* windows prebuilds have no helper */ }
  }
}

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const BIN = fileURLToPath(new URL("./agent/bin", import.meta.url))
const HOME = fileURLToPath(new URL("./out/agent/", import.meta.url))

export const Report = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("report"),
    task: Schema.Int,
    status: Schema.Literals([...Status.literals, "unknown"]),
    fact: Schema.String
  }),
  Schema.Struct({ kind: Schema.Literal("answer"), task: Schema.Int, answer: Schema.String })
])
export type Report = typeof Report.Type

export interface AgentOptions {
  readonly command: string
  readonly args: ReadonlyArray<string>
  /** Shown above the terminal, e.g. "pi · amazon-bedrock/nvidia.nemotron-nano-3-30b". */
  readonly label: string
  readonly reportUrl: string
  readonly timeoutS: number
  readonly env?: Readonly<Record<string, string>>
  /** Host variables the agent may see (credentials for its own model); nothing else is passed through. */
  readonly passEnv: ReadonlyArray<string>
}

// The agent runs shell commands chosen by a model that reads what people say on the call, so it
// sees only what it needs: the basics, plus its own model's credentials.
const BASE_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "USER", "SHELL"]
const PROXY_ENV = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"]
const BEDROCK_ENV = [
  "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_CA_BUNDLE"
]

export const agentEnv = (host: Readonly<Record<string, string | undefined>>, pass: ReadonlyArray<string>): Record<string, string> =>
  Object.fromEntries([...BASE_ENV, ...PROXY_ENV, ...pass].flatMap((k) => (host[k] === undefined ? [] : [[k, host[k]!]])))

/** Words from the call, made safe to type inside quotes: no control keys, no closing quote. */
export const said = (text: string): string =>
  text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/"/g, "'").replace(/\s+/g, " ").trim().slice(0, 400)

/** pi on Bedrock (or the scripted rehearsal model), with the demo's system prompt and only bash. */
export const piOptions = (o: { readonly model: string; readonly rehearsal: boolean; readonly reportUrl: string; readonly timeoutS: number }): AgentOptions => {
  const model = o.rehearsal ? "rehearsal/scripted" : `amazon-bedrock/${o.model}`
  return {
    command: `${ROOT}node_modules/.bin/pi`,
    args: [
      "--no-session",
      "--no-context-files",
      "--tools", "bash",
      "--append-system-prompt", `${ROOT}demo/agent/SYSTEM.md`,
      ...(o.rehearsal ? ["-e", `${ROOT}demo/agent/rehearsal.ts`] : ["--thinking", "low"]),
      "--model", model
    ],
    label: `pi · ${model}`,
    reportUrl: o.reportUrl,
    timeoutS: o.timeoutS,
    env: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: `${HOME}pi` },
    passEnv: BEDROCK_ENV
  }
}

/**
 * Any other terminal agent: `--agent-cmd "claude"` and so on. It gets the same PATH and prompts,
 * and the host variables named in `passEnv` (`--agent-env ANTHROPIC_API_KEY`).
 */
export const customOptions = (commandLine: string, reportUrl: string, timeoutS: number, passEnv: ReadonlyArray<string> = []): AgentOptions => {
  const [command, ...args] = commandLine.split(/\s+/).filter(Boolean)
  return { command: command!, args, label: commandLine, reportUrl, timeoutS, passEnv }
}

export const confirmPrompt = (task: number, item: LedgerItem): string =>
  `Task ${task} · verify a claim. ${item.speaker} said: "${said(item.claim)}" Our fast check says ${item.resource} is ` +
  `${item.status}. Check ${item.resource} yourself with the aws CLI, then run: egghead report ${task} --status ` +
  `<healthy|degraded|down|changed|unchanged> --fact "<what you found, in spoken words, at most 15 words>"`

export const answerPrompt = (task: number, speaker: string, question: string): string =>
  `Task ${task} · ${speaker} asked: "${said(question)}" Find out with the aws CLI, then run: egghead answer ${task} ` +
  `"<one spoken sentence for ${speaker}, at most 20 words>"`

/** One turn for every still-open job, oldest task first. A single item is typed as-is. */
export const inboxPrompt = (items: ReadonlyArray<{ readonly task: number; readonly line: string }>): string => {
  const ordered = [...items].sort((a, b) => a.task - b.task)
  return ordered.length === 1
    ? ordered[0]!.line
    : `Open items, oldest first. For each id, do only that item's work, then run its egghead command with that id. Do not skip, merge, or invent ids.\n\n` +
      ordered.map((it, i) => `${i + 1}. ${it.line}`).join("\n\n")
}

export class AgentTerminal extends Context.Service<AgentTerminal, {
  readonly label: string
  /** Everything the terminal printed so far (for a page that connects late), and new output as it comes. */
  readonly scrollback: () => string
  subscribe(onData: (chunk: string) => void): () => void
  resize(cols: number, rows: number): void
  /** A result from the agent's `egghead` command. False when no job is waiting for it. */
  report(body: unknown): Effect.Effect<boolean>
  /**
   * Queue a job (Bridge task id). Nearby jobs share one typed prompt; each `egghead` report
   * completes its own task. A late report from an earlier run cannot match this run's ids.
   */
  enqueue(spec: { readonly task: number; readonly line: string }): Effect.Effect<Report, SupportError>
}>()("egghead/demo/AgentTerminal") {
  static readonly layer = (options: AgentOptions) =>
    Layer.effect(AgentTerminal, Effect.gen(function*() {
      chmodPtyHelpers()
      mkdirSync(`${HOME}workspace`, { recursive: true })
      const listeners = new Set<(chunk: string) => void>()
      let scrollback = ""
      let lastOutput = Date.now()
      let size = { cols: 100, rows: 26 }
      let proc: pty.IPty | undefined
      let dead: string | undefined

      const show = (chunk: string) => {
        lastOutput = Date.now()
        scrollback = (scrollback + chunk).slice(-400_000)
        for (const l of listeners) l(chunk)
      }

      const spawn = () => {
        const p = pty.spawn(options.command, [...options.args], {
          name: "xterm-256color",
          cols: size.cols,
          rows: size.rows,
          cwd: `${HOME}workspace`,
          env: {
            ...agentEnv(process.env, options.passEnv),
            ...options.env,
            PATH: `${BIN}:${process.env.PATH ?? ""}`,
            EGGHEAD_REPORT_URL: options.reportUrl,
            TERM: "xterm-256color",
            COLORTERM: "truecolor"
          } as Record<string, string>
        })
        p.onData((chunk) => {
          if (/No model selected|No models available/.test(chunk)) {
            dead = "No model selected. aws login / Bedrock credentials, then restart the demo."
          }
          show(chunk)
        })
        p.onExit(() => {
          if (proc === p) proc = undefined
          show(`\r\n\x1b[2m[${options.label} exited]\x1b[0m\r\n`)
        })
        return p
      }
      proc = spawn()
      yield* Effect.addFinalizer(() => Effect.sync(() => proc?.kill()))

      type Slot = {
        readonly line: string
        readonly done: Deferred.Deferred<Report, SupportError>
        readonly phase: "queued" | "typed"
      }
      const waiting = yield* Ref.make(new Map<number, Slot>())
      const wake = yield* Queue.unbounded<void>()
      const decode = Schema.decodeUnknownOption(Report)

      // Type like a fast typist (a pasted wall of text is less readable on video), then Enter.
      const type = (text: string) =>
        Effect.gen(function*() {
          if (!proc) proc = spawn()
          for (let i = 0; i < text.length; i += 4) {
            proc!.write(text.slice(i, i + 4))
            yield* Effect.sleep("10 millis")
          }
          yield* Effect.sleep("150 millis")
          proc!.write("\r")
        })

      // After a report, let the agent finish its turn before typing the next inbox.
      const settle = Effect.gen(function*() {
        const until = Date.now() + 6000
        while (Date.now() < until && Date.now() - lastOutput < 800) yield* Effect.sleep("100 millis")
      })

      const failSlot = (slot: Slot, cause: string) =>
        Deferred.fail(slot.done, new SupportError({ operation: "investigate", cause }))

      const failWaiting = (cause: string) =>
        Effect.gen(function*() {
          const m = yield* Ref.get(waiting)
          yield* Ref.set(waiting, new Map())
          for (const slot of m.values()) yield* failSlot(slot, cause)
        })

      const worker = Effect.forever(Effect.gen(function*() {
        yield* Queue.take(wake)
        yield* Effect.sleep("200 millis")
        yield* Queue.takeAll(wake)
        while (true) {
          const batch = [...(yield* Ref.get(waiting)).entries()]
            .filter(([, s]) => s.phase === "queued")
            .sort((a, b) => a[0] - b[0])
          if (batch.length === 0) break
          if (dead) {
            show(`\x1b[31m  ${dead} Falling back to the fast check.\x1b[0m\r\n`)
            yield* failWaiting(dead)
            break
          }
          yield* Ref.update(waiting, (m) => {
            const next = new Map(m)
            for (const [task, slot] of batch) next.set(task, { ...slot, phase: "typed" })
            return next
          })
          const prompt = inboxPrompt(batch.map(([task, s]) => ({ task, line: s.line })))
          show(`\r\n\x1b[96m▸ ${batch.map(([t]) => t).join(", ")}\x1b[0m ${prompt.slice(0, 160)}\r\n`)
          yield* type(prompt)
          yield* Effect.forEach(
            batch,
            ([, slot]) => Deferred.await(slot.done).pipe(Effect.ignore),
            { concurrency: "unbounded" }
          )
          yield* settle
        }
      }))
      yield* Effect.forkScoped(worker)

      const enqueue = (spec: { readonly task: number; readonly line: string }) =>
        Effect.gen(function*() {
          if (dead) {
            show(`\x1b[31m  ${dead} Falling back to the fast check.\x1b[0m\r\n`)
            return yield* Effect.fail(new SupportError({ operation: "investigate", cause: dead }))
          }
          const done = yield* Deferred.make<Report, SupportError>()
          yield* Ref.update(waiting, (m) => new Map(m).set(spec.task, { line: spec.line, done, phase: "queued" }))
          yield* Queue.offer(wake, undefined)
          const timed = yield* Deferred.await(done).pipe(
            Effect.timeoutOption(Duration.seconds(options.timeoutS)),
            Effect.ensuring(Ref.update(waiting, (m) => {
              const next = new Map(m)
              next.delete(spec.task)
              return next
            }))
          )
          if (Option.isNone(timed)) {
            proc?.write("\x1b") // interrupt the agent's turn (pi: Escape aborts)
            yield* failSlot({ line: spec.line, done, phase: "typed" }, `no report within ${options.timeoutS} s`)
            return yield* Effect.fail(new SupportError({ operation: "investigate", cause: `no report within ${options.timeoutS} s` }))
          }
          return timed.value
        })

      return AgentTerminal.of({
        label: options.label,
        scrollback: () => scrollback,
        subscribe: (onData) => {
          listeners.add(onData)
          return () => listeners.delete(onData)
        },
        resize: (cols, rows) => {
          size = { cols: Math.max(40, Math.min(240, cols)), rows: Math.max(10, Math.min(80, rows)) }
          proc?.resize(size.cols, size.rows)
        },
        report: (body) =>
          Effect.gen(function*() {
            const r = decode(body)
            if (Option.isNone(r)) return false
            const slot = (yield* Ref.get(waiting)).get(r.value.task)
            if (!slot) return false
            return yield* Deferred.succeed(slot.done, r.value)
          }),
        enqueue
      })
    }))

  /** The Bridge's Investigator, backed by the terminal agent. */
  static readonly investigator = Layer.effect(Investigator, Effect.gen(function*() {
    const agent = yield* AgentTerminal
    const wrong = (task: number, got: string) =>
      Effect.fail(new SupportError({ operation: "investigate", cause: `task ${task}: expected a different report kind, got ${got}` }))
    return Investigator.of({
      name: agent.label,
      confirm: (task, item) =>
        Effect.flatMap(agent.enqueue({ task, line: confirmPrompt(task, item) }), (r) =>
          r.kind === "report" ? Effect.succeed({ status: r.status, fact: r.fact, by: agent.label }) : wrong(task, r.kind)),
      answer: (task, q) =>
        Effect.flatMap(agent.enqueue({ task, line: answerPrompt(task, q.speaker, q.text) }), (r) =>
          r.kind === "answer" ? Effect.succeed(r.answer) : wrong(task, r.kind))
    })
  }))
}
