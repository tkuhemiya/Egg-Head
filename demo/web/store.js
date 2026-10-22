// The run as the pages see it: the event stream from /events folded into transcript lines,
// checks, agent tasks, questions and the moments Egg Head chose to stay quiet. Both the meeting
// page and the dashboard render from this.

export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
export const secs = (ms) => `${(ms / 1000).toFixed(1)} s`

export function createStore() {
  const listeners = new Set()
  let s = blank()

  function blank() {
    return {
      meta: null,
      status: "",
      running: false,
      done: false,
      lines: [], // index -> { index, speaker, text, heard, cut, at, events: [], said: [] }
      egg: [], // { index, text, kind, at, durationS }
      checks: [], // { index, at, speaker, claim, check, resource, verdict, evidence, by }
      tasks: new Map(), // task -> { task, job, detail, index, dispatchedAt, reportedAt, result, by, ms, state }
      requests: new Map(), // id -> Request
      quiet: [], // { index, at, why }
      claims: new Map(), // turn -> { speaker, text, state, check, resource }
      stats: null,
      floor: null, // line index when Egg Head took the floor
      hold: false,
      lastAt: 0
    }
  }

  const line = (i) => (s.lines[i] ??= { index: i, speaker: "", text: "", heard: "", cut: null, at: 0, events: [], said: [], expect: "" })
  const quiet = (index, at, why) => {
    if (!s.quiet.some((q) => q.why === why)) s.quiet.push({ index, at, why })
  }

  // The claim a step was about: the Bridge says so with an Investigator; otherwise the oldest open one.
  const claimOf = (ev) =>
    ev.claim !== undefined ? s.claims.get(ev.claim) : [...s.claims.values()].find((c) => c.state === "contradicted" || c.state === "confirmed")
  const setClaim = (ev, state, extra = {}) => {
    const c = claimOf(ev)
    if (c) Object.assign(c, { state }, extra)
    return c
  }

  function onEvent(index, ev, at) {
    const l = line(index)
    l.events.push(ev)
    const rt = ev.route
    if (rt && ev.speaker !== "(silence)" && ev.speaker !== "(agent)" && rt.action === "check" && ev.verdict) {
      s.checks.push({
        index, at, turn: ev.turn, speaker: ev.speaker, claim: ev.text, check: rt.check, resource: rt.resource, verdict: ev.verdict,
        evidence: ev.checkEvidence, by: rt.scores?.bedrock !== undefined ? "Bedrock routed" : "fast check", asserted: rt.asserted
      })
      if (ev.verdict !== "inconclusive") {
        s.claims.set(ev.turn, {
          turn: ev.turn, index, speaker: ev.speaker, text: ev.text, check: rt.check, resource: rt.resource, evidence: ev.checkEvidence,
          state: ev.verdict === "contradicts" ? "contradicted" : "true"
        })
      }
      if (ev.verdict === "supports") quiet(index, at, `${ev.speaker}'s claim checks out.`)
    }
    if (ev.agent) {
      const a = ev.agent
      const t = s.tasks.get(a.task) ?? { task: a.task, job: a.job, index, state: "running" }
      if (a.action === "dispatched") Object.assign(t, { detail: a.detail, dispatchedAt: at, index })
      if (a.action === "reported") Object.assign(t, { result: a.detail, by: a.by, ms: a.ms, reportedAt: at, state: "done" })
      if (a.action === "failed") Object.assign(t, { result: a.detail, state: "failed" })
      s.tasks.set(a.task, t)
      if (a.job === "confirm" && a.action === "dispatched") setClaim(ev, "checking", { task: a.task })
      if (a.job === "confirm" && a.action === "reported") {
        const c = claimOf(ev)
        if (c && c.state === "checking") {
          if (/^overruled/.test(a.detail)) {
            c.state = "overruled"
            quiet(index, at, `${c.speaker} was right after all.`)
          } else c.state = "confirmed"
        }
      }
    }
    if (ev.request) {
      const r = ev.request
      const before = s.requests.get(r.id)
      s.requests.set(r.id, { ...r, index: before?.index ?? index })
      if (r.state === "dropped" && before?.state !== "dropped") quiet(index, at, `Someone else answered ${r.speaker}.`)
    }
    if (ev.note) {
      l.notes = [...(l.notes ?? []), ev.note]
      if (/before any LLM call/.test(ev.note)) {
        const c = setClaim(ev, "corrected", { repairedBy: /\((\w+)\)/.exec(ev.note)?.[1] })
        quiet(index, at, `The call corrected ${c?.speaker ?? "the claim"} on its own.`)
      }
      if (/has not finished/.test(ev.note) && ev.request) quiet(index, at, `${ev.request.speaker} hasn't finished talking.`)
    }
    const g = ev.gate
    if (g) {
      l.gate = g
      l.gateScores = ev.gateScores
      const gc = claimOf(ev)
      if (gc) gc.gate = g
      if (g.repairedBy) {
        const c = setClaim(ev, "corrected", { repairedBy: g.repairedBy })
        quiet(index, at, `The call corrected ${c?.speaker ?? "the claim"} on its own.`)
      } else if (!g.speak && g.blockedBy === "worth_it") {
        setClaim(ev, "parked")
        quiet(index, at, "The call parked the topic.")
      }
    }
    if (ev.said && (ev.saidKind === "flag" || ev.saidKind === "barge" || !ev.saidKind)) {
      setClaim(ev, ev.saidKind === "barge" ? "barged" : "raised", { said: ev.said, directive: ev.gateScores?.directive })
    }
  }

  function apply(m) {
    const at = m.at ?? s.lastAt
    s.lastAt = at
    switch (m.type) {
      case "reset": s = blank(); s.running = true; break
      case "status": s.status = m.text; s.running = true; break
      case "meta": s.meta = m; s.running = true; break
      case "line": Object.assign(line(m.index), { speaker: m.speaker, text: m.text, at, expect: m.expect, durationS: m.durationS }); break
      case "cut": line(m.index).cut = m.text; break
      case "heard": line(m.index).heard = m.text; break
      case "event": onEvent(m.index, m.event, at); break
      case "floor": s.floor = m.index; break
      case "hold": s.hold = m.on; break
      case "egghead": {
        s.floor = null
        const e = { index: m.index, text: m.text, kind: m.kind, at, durationS: m.durationS }
        s.egg.push(e)
        line(m.index).said.push(e)
        break
      }
      case "stats": s.stats = m.stats; break
      case "done": s.done = true; s.running = false; break
    }
    for (const fn of listeners) fn(s, m)
  }

  return {
    apply,
    get: () => s,
    subscribe: (fn) => (listeners.add(fn), () => listeners.delete(fn))
  }
}

/** Live stream, or the last run with ?replay (no live connection). */
export function connect(store) {
  if (new URLSearchParams(location.search).has("replay")) {
    fetch("/history").then((r) => r.json()).then((ms) => ms.forEach((m) => store.apply(m)))
    return
  }
  const source = new EventSource("/events")
  source.onmessage = (e) => store.apply(JSON.parse(e.data))
}

/** What Egg Head is doing right now, for its tile and the side panel. */
export function eggState(s) {
  const running = [...s.tasks.values()].filter((t) => t.state === "running")
  const listening = [...s.requests.values()].find((r) => r.state === "listening" && r.kind === "addressed")
  const ready = [...s.requests.values()].find((r) => r.state === "ready")
  const confirmed = [...s.claims.values()].find((c) => c.state === "confirmed")
  if (s.floor !== null) return { key: "floor", text: "Taking the floor…" }
  if (running.length) return { key: "checking", text: "Checking" }
  if (ready || confirmed) return { key: "gap", text: "Waiting for a gap to speak" }
  if (listening) return { key: "waiting", text: `Waiting for ${listening.speaker} to finish` }
  if (s.running) return { key: "listening", text: "Listening" }
  return { key: "idle", text: s.done ? "Call ended" : "Ready" }
}
