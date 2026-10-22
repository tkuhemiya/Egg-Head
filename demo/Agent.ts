/**
 * The demo's Investigator: a coding agent in a real terminal (a pseudo-terminal, node-pty),
 * shown live on the dashboard. Egg Head types each job into the agent's prompt the way a
 * person would, and the agent hands its result back by running `egghead report|answer`
 * (demo/agent/bin/egghead -> POST /agent/report). Any terminal agent that can run shell
 * commands works; the default is pi on Amazon Bedrock.
 *
 * The agent's shell has the stand-in AWS CLI first on PATH (demo/agent/bin/aws), which answers
 * from data/aws.json. Jobs run one at a time, each with a timeout; on a timeout or a crash the
 * Bridge falls back to the direct check (Investigator.direct).
 */
import { Context, Deferred, Duration, Effect, Layer, Option, Ref, Schema, Semaphore } from "effect"
import { mkdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as pty from "node-pty"
import { Investigator } from "../src/Investigator.ts"
import type { LedgerItem } from "../src/Ledger.ts"
import { SupportError } from "../src/Speaker.ts"
import { Status } from "../src/Checks.ts"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const BIN = fileURLToPath(new URL("./agent/bin", import.meta.url))
const HOME = fileURLToPath(new URL("./out/agent/", import.meta.url))

export const Report = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("report"), task: Schema.Int, status: Status, fact: Schema.String }),
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
}

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
    env: { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: `${HOME}pi` }
  }
}

/** Any other terminal agent: `--agent-cmd "claude"` and so on. It gets the same PATH and prompts. */
export const customOptions = (commandLine: string, reportUrl: string, timeoutS: number): AgentOptions => {
  const [command, ...args] = commandLine.split(/\s+/).filter(Boolean)
  return { command: command!, args, label: commandLine, reportUrl, timeoutS }
}

export const confirmPrompt = (task: number, item: LedgerItem): string =>
  `Task ${task} · verify a claim. ${item.speaker} said: "${item.claim}" Our fast check says ${item.resource} is ` +
  `${item.status}. Check ${item.resource} yourself with the aws CLI, then run: egghead report ${task} --status ` +
  `<healthy|degraded|down|changed|unchanged> --fact "<what you found, in spoken words, at most 15 words>"`

export const answerPrompt = (task: number, speaker: string, question: string): string =>
  `Task ${task} · ${speaker} asked: "${question}" Find out with the aws CLI, then run: egghead answer ${task} ` +
  `"<one spoken sentence for ${speaker}, at most 20 words>"`

export class AgentTerminal extends Context.Service<AgentTerminal, {
  readonly label: string
  /** Everything the terminal printed so far (for a page that connects late), and new output as it comes. */
  readonly scrollback: () => string
  subscribe(onData: (chunk: string) => void): () => void
  resize(cols: number, rows: number): void
  /** A result from the agent's `egghead` command. False when no job is waiting for it. */
  report(body: unknown): Effect.Effect<boolean>
  /** Type a job into the agent and wait for its report. */
  submit(task: number, prompt: string): Effect.Effect<Report, SupportError>
}>()("egghead/demo/AgentTerminal") {
  static readonly layer = (options: AgentOptions) =>
    Layer.effect(AgentTerminal, Effect.gen(function*() {
      mkdirSync(`${HOME}workspace`, { recursive: true })
      const listeners = new Set<(chunk: string) => void>()
      let scrollback = ""
      let lastOutput = Date.now()
      let size = { cols: 100, rows: 26 }
      let proc: pty.IPty | undefined

      const spawn = () => {
        const p = pty.spawn(options.command, [...options.args], {
          name: "xterm-256color",
          cols: size.cols,
          rows: size.rows,
          cwd: `${HOME}workspace`,
          env: {
            ...process.env,
            ...options.env,
            PATH: `${BIN}:${process.env.PATH ?? ""}`,
            EGGHEAD_REPORT_URL: options.reportUrl,
            TERM: "xterm-256color",
            COLORTERM: "truecolor"
          } as Record<string, string>
        })
        p.onData((chunk) => {
          lastOutput = Date.now()
          scrollback = (scrollback + chunk).slice(-400_000)
          for (const l of listeners) l(chunk)
        })
        p.onExit(() => {
          if (proc === p) proc = undefined
          const note = `\r\n\x1b[2m[${options.label} exited]\x1b[0m\r\n`
          scrollback += note
          for (const l of listeners) l(note)
        })
        return p
      }
      proc = spawn()
      yield* Effect.addFinalizer(() => Effect.sync(() => proc?.kill()))

      const waiting = yield* Ref.make(new Map<number, Deferred.Deferred<Report>>())
      const one = yield* Semaphore.make(1)
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

      // After a report, let the agent finish its turn before typing the next job.
      const settle = Effect.gen(function*() {
        const until = Date.now() + 6000
        while (Date.now() < until && Date.now() - lastOutput < 800) yield* Effect.sleep("100 millis")
      })

      const submit = (task: number, prompt: string) =>
        one.withPermits(1)(Effect.gen(function*() {
          const done = yield* Deferred.make<Report>()
          yield* Ref.update(waiting, (m) => new Map(m).set(task, done))
          yield* type(prompt)
          const report = yield* Deferred.await(done).pipe(
            Effect.timeoutOption(Duration.seconds(options.timeoutS)),
            Effect.ensuring(Ref.update(waiting, (m) => {
              const next = new Map(m)
              next.delete(task)
              return next
            }))
          )
          if (Option.isNone(report)) {
            proc?.write("\x1b") // interrupt the agent's turn (pi: Escape aborts)
            return yield* Effect.fail(new SupportError({ operation: "investigate", cause: `no report within ${options.timeoutS} s` }))
          }
          yield* settle
          return report.value
        }))

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
            const done = (yield* Ref.get(waiting)).get(r.value.task)
            if (!done) return false
            return yield* Deferred.succeed(done, r.value)
          }),
        submit
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
        Effect.flatMap(agent.submit(task, confirmPrompt(task, item)), (r) =>
          r.kind === "report" ? Effect.succeed({ status: r.status, fact: r.fact, by: agent.label }) : wrong(task, r.kind)),
      answer: (task, q) =>
        Effect.flatMap(agent.submit(task, answerPrompt(task, q.speaker, q.text)), (r) =>
          r.kind === "answer" ? Effect.succeed(r.answer) : wrong(task, r.kind))
    })
  }))
}
