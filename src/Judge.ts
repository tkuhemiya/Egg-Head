/**
 * Judge: score what a call did against what its scenario said it should do.
 *
 * Pure: a call log in (offline from TestClock, or a saved live run), a Report out. `observe`
 * turns the log into what happened on each line; `judge` compares that with each line's
 * `expect` and the call's `never`. Everything is read from Bridge Event fields and the loop's
 * `at` stamps, never from the words Egg Head said.
 */
import { Option, Result, Schema } from "effect"
import type { Event } from "./Bridge.ts"
import { type Call, expectOf, type Logged } from "./Call.ts"
import {
  describeInvariant,
  describeOutcome,
  type Invariant,
  type Outcome,
  type SaidKind,
  type Says,
  type Timing,
  UNPROMPTED
} from "./Expect.ts"
import { aliasHits } from "./Router.ts"

// ---------------------------------------------------------------------------
// What happened
// ---------------------------------------------------------------------------

export interface Said {
  readonly _tag: "Said"
  readonly kind: SaidKind
  readonly text: string
  readonly toward: Option.Option<string>
  readonly about: Option.Option<string>
  /** When the Bridge decided to say it, seconds since the call started. */
  readonly at: number
  /** When the line was voiced (live, after synthesis); `at` when it never was. */
  readonly start: number
  readonly end: number
}

export interface Dispatched {
  readonly _tag: "Dispatched"
  readonly job: "confirm" | "answer"
  readonly at: number
}

export type Observed = Said | Dispatched

export interface LineTrace {
  readonly index: number
  readonly speaker: string
  readonly text: string
  readonly played: boolean
  readonly start: number
  /** End of the line's audio, or the moment it was cut off. */
  readonly end: number
  readonly cut: boolean
  readonly observed: ReadonlyArray<Observed>
  /** The Bridge's own notes on this line, for failure reports. */
  readonly notes: ReadonlyArray<string>
}

export interface Trace {
  readonly lines: ReadonlyArray<LineTrace>
  readonly said: ReadonlyArray<Said & { readonly index: number }>
  readonly complete: boolean
}

/** The script no longer matches the run: scoring would be a guess. */
export class ScriptMismatch extends Schema.TaggedError<ScriptMismatch>()("ScriptMismatch", {
  index: Schema.Int,
  scripted: Schema.String,
  recorded: Schema.String
}) {}

const kindOf = (ev: Event): SaidKind => {
  if (ev.speech !== undefined && Option.isSome(ev.speech)) return ev.speech.value.kind
  const kind = ev.saidKind ?? "flag"
  return kind === "ack" && ev.request?.kind === "open" ? "take" : kind === "retract" ? "retract" : kind
}

export const observe = (call: Call, log: ReadonlyArray<Logged>): Result.Result<Trace, ScriptMismatch> => {
  const lines = call.lines.map((l, index) => ({
    index,
    speaker: l.speaker,
    text: l.text,
    played: false,
    start: 0,
    end: 0,
    cut: false,
    observed: [] as Array<Observed>,
    notes: [] as Array<string>
  }))
  const said: Array<Said & { index: number }> = []
  const voiced: Array<Extract<Logged, { type: "egghead" }>> = []
  const claims = new Map<number, { speaker: string; resource: Option.Option<string> }>() // Bridge turn -> claim
  let complete = false

  for (const m of log) {
    const s = m.at / 1000
    switch (m.type) {
      case "line": {
        const l = lines[m.index]
        if (l === undefined || l.text !== m.text) {
          return Result.fail(new ScriptMismatch({ index: m.index, scripted: l?.text ?? "(no such line)", recorded: m.text }))
        }
        Object.assign(l, { played: true, start: s, end: s + m.durationS })
        break
      }
      case "cut":
        if (lines[m.index]) Object.assign(lines[m.index]!, { cut: true, end: s })
        break
      case "egghead":
        voiced.push(m)
        break
      case "done":
        complete = true
        break
      case "event": {
        const ev = m.event
        const l = lines[m.index]
        if (l === undefined) break
        if (Option.isSome(ev.route)) {
          claims.set(ev.turn, { speaker: ev.speaker, resource: Option.flatMap(ev.route, (r) => r.resource) })
        }
        if (ev.note !== undefined) l.notes.push(ev.note)
        for (const mv of ev.moves ?? []) if (mv._tag === "Note") l.notes.push(mv.text)
        const dispatched = (ev.moves ?? []).filter((mv) => mv._tag === "Dispatched")
        if (dispatched.length > 0) {
          for (const mv of dispatched) {
            if (mv.via === "direct" && mv.kind !== "confirm") continue // fallback is not a new investigation
            l.observed.push({ _tag: "Dispatched", job: mv.kind === "answer" ? "answer" : "confirm", at: s })
          }
        } else if (ev.agent?.action === "dispatched") {
          l.observed.push({ _tag: "Dispatched", job: ev.agent.job, at: s })
        }
        const saidText = ev.speech !== undefined && Option.isSome(ev.speech) ? ev.speech.value.text : Option.getOrUndefined(ev.said)
        if (saidText !== undefined) {
          const kind = kindOf(ev)
          const speech = ev.speech !== undefined && Option.isSome(ev.speech) ? ev.speech.value : undefined
          const claim = ev.claim === undefined ? undefined : claims.get(ev.claim)
          const asked = ev.request
          const toward = speech?.toward !== undefined
            ? Option.some(speech.toward)
            : kind === "barge"
            ? Option.some(ev.speaker)
            : kind === "flag" || kind === "retract"
            ? Option.fromUndefinedOr(claim?.speaker)
            : Option.fromUndefinedOr(asked?.speaker)
          const about = speech?.about !== undefined
            ? speech.about
            : kind === "flag" || kind === "barge" || kind === "retract"
            ? Option.flatten(Option.fromUndefinedOr(claim?.resource))
            : Option.fromUndefinedOr(asked && aliasHits(asked.text)[0])
          const o: Said = { _tag: "Said", kind, text: saidText, toward, about, at: s, start: s, end: s }
          l.observed.push(o)
          said.push({ ...o, index: m.index })
        }
        break
      }
    }
  }
  // the loop voices each said event in order, so the k-th voiced line is the k-th said
  const timed = said.map((o, k) => {
    const v = voiced[k]
    return v ? { ...o, start: v.at / 1000, end: v.at / 1000 + v.durationS } : o
  })
  return Result.succeed({ lines, said: timed, complete })
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/** How much timing slack a run gets. Never forgives being early by more than a tick. */
export interface Tolerance {
  readonly lateS: number
  readonly earlyS: number
}
export const OFFLINE: Tolerance = { lateS: 0, earlyS: 0 }
/** Live: Decider, ASR and voice latency the scripted run does not have. */
export const LIVE: Tolerance = { lateS: 1.0, earlyS: 0.05 }

export type Problem =
  | { readonly _tag: "Missing"; readonly expected: Outcome; readonly foundIn: Option.Option<number> }
  | { readonly _tag: "Unexpected"; readonly observed: Observed }
  | { readonly _tag: "Mismatch"; readonly expected: Says; readonly observed: Said; readonly fields: ReadonlyArray<string> }
  | { readonly _tag: "NotPlayed" }

export interface LineVerdict {
  readonly index: number
  readonly ok: boolean
  readonly expected: ReadonlyArray<Outcome>
  readonly problems: ReadonlyArray<Problem>
  readonly trace: LineTrace
}

export interface InvariantVerdict {
  readonly invariant: Invariant
  readonly ok: boolean
  readonly detail: string
}

export interface Report {
  readonly title: string
  readonly lines: ReadonlyArray<LineVerdict>
  readonly invariants: ReadonlyArray<InvariantVerdict>
  readonly complete: boolean
  readonly passed: boolean
  readonly summary: string
}

const sameKind = (e: Outcome, o: Observed) =>
  e._tag === "Says" ? o._tag === "Said" && o.kind === e.kind : o._tag === "Dispatched" && o.job === e.job

const relative = (when: Timing, line: LineTrace, o: Said) => o.at - (when.since === "lineEnd" ? line.end : line.start)

const inWindow = (when: Timing, t: number, tol: Tolerance) =>
  (when.minS === undefined || t >= when.minS - tol.earlyS - 1e-9) && (when.maxS === undefined || t <= when.maxS + tol.lateS + 1e-9)

/** The fields of `e` that `o` does not satisfy. */
const mismatches = (e: Says, o: Said, line: LineTrace, tol: Tolerance): ReadonlyArray<string> => [
  ...(e.toward !== undefined && Option.getOrUndefined(o.toward) !== e.toward ? ["toward"] : []),
  ...(e.about !== undefined && Option.getOrUndefined(o.about) !== e.about ? ["about"] : []),
  ...(e.when !== undefined && !inWindow(e.when, relative(e.when, line, o), tol) ? ["when"] : [])
]

const judgeLine = (line: LineTrace, expected: ReadonlyArray<Outcome>, all: ReadonlyArray<LineTrace>, tol: Tolerance): LineVerdict => {
  if (!line.played) return { index: line.index, ok: false, expected, problems: [{ _tag: "NotPlayed" }], trace: line }
  const left = [...line.observed]
  const problems: Array<Problem> = []
  for (const e of expected) {
    const candidates = left.filter((o) => sameKind(e, o))
    const exact = e._tag === "Says"
      ? candidates.find((o) => mismatches(e, o as Said, line, tol).length === 0)
      : candidates[0]
    const taken = exact ?? candidates[0]
    if (taken === undefined) {
      const elsewhere = all.filter((l) => l.index !== line.index && l.observed.some((o) => sameKind(e, o)))
        .sort((a, b) => Math.abs(a.index - line.index) - Math.abs(b.index - line.index))[0]
      problems.push({ _tag: "Missing", expected: e, foundIn: Option.fromUndefinedOr(elsewhere?.index) })
      continue
    }
    left.splice(left.indexOf(taken), 1)
    if (exact === undefined && e._tag === "Says") {
      problems.push({ _tag: "Mismatch", expected: e, observed: taken as Said, fields: mismatches(e, taken as Said, line, tol) })
    }
  }
  for (const o of left) problems.push({ _tag: "Unexpected", observed: o })
  return { index: line.index, ok: problems.length === 0, expected, problems, trace: line }
}

const at = (s: number) => `${s.toFixed(2)} s`

const checkInvariant = (i: Invariant, trace: Trace, tol: Tolerance): InvariantVerdict => {
  const humans = trace.lines.filter((l) => l.played)
  const speeches = trace.said
  const fail = (detail: string): InvariantVerdict => ({ invariant: i, ok: false, detail })
  switch (i._tag) {
    case "NoTalkOver": {
      for (const s of speeches) {
        const over = humans.find((l) => l.start < s.end - 1e-6 && l.end > s.start + 1e-6 && !(s.kind === "barge" && l.index === s.index))
        if (over) return fail(`Egg Head's ${s.kind} (line ${s.index}, ${at(s.start)}-${at(s.end)}) overlaps line ${over.index} (${at(over.start)}-${at(over.end)})`)
        const self = speeches.find((t) => t !== s && t.start > s.start - 1e-6 && t.start < s.end - 1e-6)
        if (self) return fail(`Egg Head's ${self.kind} at ${at(self.start)} starts while its ${s.kind} (${at(s.start)}-${at(s.end)}) is still playing`)
      }
      break
    }
    case "SilenceBeforeSpeaking": {
      for (const s of speeches.filter((s) => s.kind !== "barge")) {
        const before = humans.filter((l) => l.start <= s.start)
        const lastEnd = Math.max(...before.map((l) => l.end))
        if (before.length > 0 && s.start - lastEnd < i.minS - tol.earlyS - 1e-9) {
          return fail(`${s.kind} on line ${s.index} started ${at(s.start - lastEnd)} after the last line ended`)
        }
      }
      break
    }
    case "OneLinePerGap": {
      for (let k = 1; k < speeches.length; k++) {
        const [a, b] = [speeches[k - 1]!, speeches[k]!]
        const human = humans.some((l) => l.start > a.start && l.start < b.start)
        if (!human && b.start - a.end < i.quietS - tol.earlyS - 1e-9) {
          return fail(`${b.kind} on line ${b.index} came ${at(b.start - a.end)} after Egg Head's ${a.kind}, with nobody speaking in between`)
        }
      }
      break
    }
    case "Cooldown": {
      const unprompted = speeches.filter((s) => UNPROMPTED.includes(s.kind))
      for (let k = 1; k < unprompted.length; k++) {
        const [a, b] = [unprompted[k - 1]!, unprompted[k]!]
        if (b.kind === "flag" && b.at - a.at < i.s - tol.earlyS - 1e-9) {
          return fail(`flag on line ${b.index} came ${at(b.at - a.at)} after the ${a.kind} on line ${a.index}`)
        }
      }
      break
    }
    case "MaxSpeeches":
      if (speeches.length > i.n) return fail(`${speeches.length} lines`)
      break
  }
  return { invariant: i, ok: true, detail: "" }
}

export const judge = (call: Call, log: ReadonlyArray<Logged>, tol: Tolerance = OFFLINE): Result.Result<Report, ScriptMismatch> =>
  Result.map(observe(call, log), (trace) => {
    const lines = trace.lines.map((l) => judgeLine(l, expectOf(call.lines[l.index]!), trace.lines, tol))
    const invariants = (call.never ?? []).map((i) => checkInvariant(i, trace, tol))
    const good = lines.filter((l) => l.ok).length
    const held = invariants.filter((i) => i.ok).length
    const summary = `${good} of ${lines.length} lines behaved as expected` +
      (invariants.length ? `; ${held} of ${invariants.length} invariants held` : "") +
      (trace.complete ? "" : "; the run did not finish")
    return {
      title: call.title,
      lines,
      invariants,
      complete: trace.complete,
      passed: good === lines.length && held === invariants.length && trace.complete,
      summary
    }
  })

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const describeSaid = (o: Observed, line: LineTrace): string => {
  if (o._tag === "Dispatched") return `investigates (${o.job}) at ${at(o.at - line.end)} after the line`
  const parts = [o.kind, Option.match(o.toward, { onNone: () => "", onSome: (t) => `to ${t}` }), Option.match(o.about, { onNone: () => "", onSome: (a) => `about ${a}` })]
  return `${parts.filter(Boolean).join(" ")} ${at(o.at - line.end)} after the line: "${o.text}"`
}

const describeProblem = (p: Problem, line: LineTrace): ReadonlyArray<string> => {
  switch (p._tag) {
    case "NotPlayed":
      return ["the run ended before this line"]
    case "Missing":
      return [`missing    ${describeOutcome(p.expected)}${Option.match(p.foundIn, { onNone: () => "", onSome: (i) => ` (came on line ${i})` })}`]
    case "Unexpected":
      return [`unexpected ${describeSaid(p.observed, line)}`]
    case "Mismatch":
      return [
        `expected   ${describeOutcome(p.expected)}`,
        `observed   ${describeSaid(p.observed, line)} (${p.fields.join(", ")} differ${p.fields.length === 1 ? "s" : ""})`
      ]
  }
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 1) + "…" : s.padEnd(n))

/** The per-line table, the invariants, then the summary line. */
export const render = (report: Report, options: { readonly onlyFailures?: boolean } = {}): string => {
  const out: Array<string> = [report.title]
  for (const l of report.lines) {
    if (options.onlyFailures && l.ok) continue
    const expected = l.expected.length === 0 ? "quiet" : l.expected.map(describeOutcome).join("; ")
    out.push(`  ${l.ok ? "ok  " : "FAIL"} ${String(l.index).padStart(2)} ${pad(l.trace.speaker, 7)} ${pad(l.trace.text, 44)} ${expected}`)
    if (!l.ok) {
      for (const p of l.problems) for (const row of describeProblem(p, l.trace)) out.push(`          ${row}`)
      for (const n of l.trace.notes) out.push(`          bridge     ${n}`)
    }
  }
  for (const i of report.invariants) {
    if (options.onlyFailures && i.ok) continue
    out.push(`  ${i.ok ? "ok  " : "FAIL"}    ${describeInvariant(i.invariant)}${i.ok ? "" : `: ${i.detail}`}`)
  }
  out.push(report.summary)
  return out.join("\n")
}
