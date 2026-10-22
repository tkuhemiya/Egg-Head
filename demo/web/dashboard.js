// The run dashboard: the meeting transcript with what each line triggered (Decider, the fast
// check, the gate, the LLM agent, what Egg Head said or why it stayed quiet), plus the checks,
// agent tasks and questions of the run. Live, or the last run with ?replay.
import { personOf } from "./avatars.js"
import { connect, createStore, esc, GATE, KIND_LABEL, pct, secs } from "./store.js"

const $ = (id) => document.getElementById(id)
const cfg = await fetch("/config").then((r) => r.json())
$("title").textContent = cfg.title
$("agent-label").textContent = cfg.agent === "none" ? "no agent" : cfg.agent
$("mode").textContent = `${cfg.mode === "transcribe" ? "Amazon Transcribe" : "transcript mode"}${cfg.rehearsal ? " · rehearsal" : ""}`
const colors = Object.fromEntries(cfg.people.map((p, i) => [p, personOf(p, i).shirt]))
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

const CLAIM_STATE = {
  contradicted: "contradicted",
  checking: "agent verifying",
  confirmed: "confirmed, waiting for a gap",
  raised: "raised by Egg Head",
  barged: "Egg Head cut in",
  corrected: "the call corrected it",
  true: "true",
  overruled: "agent: it was right",
  parked: "parked by the call"
}
const REQUEST_STATE = { listening: "listening", checking: "agent checking", ready: "answer ready", answered: "answered by Egg Head", dropped: "the call answered" }

const store = createStore()
let pending = false
store.subscribe((s, m) => {
  if (m.type === "done") {
    $("start").disabled = false
    $("start").textContent = "Run again"
  }
  if (!pending) {
    pending = true
    requestAnimationFrame(() => {
      pending = false
      render(store.get())
    })
  }
})

function render(s) {
  $("live").classList.toggle("on", s.running)
  renderKpis(s)
  renderTranscript(s)
  renderChecks(s)
  renderTasks(s)
  renderQuestions(s)
  renderQuiet(s)
}

function renderKpis(s) {
  const lines = s.lines.filter((l) => l?.speaker)
  const st = s.stats
  $("k-lines").textContent = lines.length
  $("k-decider").textContent = st?.deciderBatches ? `Decider ${st.deciderBatches} calls, p50 ${st.deciderMsP50} ms` : "Decider –"
  $("k-checks").textContent = s.checks.length
  $("k-wrong").textContent = `${s.checks.filter((c) => c.verdict === "contradicts").length} contradicted`
  $("k-llm").textContent = st ? st.agentTasks + st.bedrockCalls : 0
  $("k-every").textContent = `vs ${lines.length} with an LLM on every line`
  $("k-spoke").textContent = s.egg.length
  const kinds = {}
  for (const e of s.egg) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1
  $("k-kinds").textContent = Object.entries(kinds).map(([k, n]) => `${n} ${(KIND_LABEL[k] ?? k).toLowerCase()}`).join(" · ") || "–"
  $("k-quiet").textContent = s.quiet.length
  const reqs = [...s.requests.values()]
  $("k-questions").textContent = reqs.length
  $("k-q").textContent = reqs.length
    ? `${reqs.filter((r) => r.state === "answered").length} answered by Egg Head · ${reqs.filter((r) => r.state === "dropped").length} by the call`
    : "–"
}

function renderTranscript(s) {
  const lines = s.lines.filter((l) => l?.speaker)
  if (!lines.length) return
  const box = $("transcript")
  const nearBottom = window.innerHeight + window.scrollY > document.body.scrollHeight - 80
  box.innerHTML = lines.map((l) => {
    const main = l.events.find((e) => e.speaker === l.speaker && e.route)
    const tags = []
    if (main) {
      const rt = main.route
      tags.push(`<span class="tag decider">Decider <b>${Math.round(main.deciderMs)} ms</b></span>`)
      const claim = rt.scores?.claim
      if (rt.action === "check") {
        tags.push(`<span class="tag claim">claim <b>${pct(claim)}</b> · says <b>${esc(rt.asserted ?? "?")}</b></span>`)
        tags.push(`<span class="tag claim">check <b>${esc(rt.check)}</b> on <b>${esc(rt.resource)}</b></span>`)
        if (main.verdict) tags.push(main.verdict === "contradicts" ? `<span class="tag bad">✗ contradicted: ${esc(main.checkEvidence)}</span>` : main.verdict === "supports" ? `<span class="tag good">✓ true: ${esc(main.checkEvidence)}</span>` : `<span class="tag">inconclusive</span>`)
      } else if (rt.action === "escalate") {
        tags.push(`<span class="tag claim">claim <b>${pct(claim)}</b>, could not route</span>`)
      } else {
        tags.push(`<span class="tag">not a claim (${pct(claim)})</span>`)
      }
      const req = l.events.find((e) => e.request && e.request.turn === main.turn)?.request
      if (req?.kind === "addressed" && req.note?.startsWith("asked")) tags.push(`<span class="tag ask">talking to Egg Head <b>${pct(main.gateScores?.addressed)}</b></span>`)
      if (req?.kind === "addressed" && req.note === "still asking") tags.push(`<span class="tag ask">still asking Egg Head</span>`)
      if (req?.kind === "open") tags.push(`<span class="tag ask">question to the call <b>${pct(main.gateScores?.asks)}</b></span>`)
      if (main.gateScores?.finished !== undefined && (req || l.gate)) tags.push(`<span class="tag">P(finished) <b>${pct(main.gateScores.finished)}</b></span>`)
    }
    const partial = l.events.find((e) => e.gateScores?.directive !== undefined && e.said)
    if (partial) tags.push(`<span class="tag bad">instruction to act <b>${pct(partial.gateScores.directive)}</b></span>`)
    const gateEv = [...l.events].reverse().find((e) => e.gate)
    if (gateEv) {
      const g = gateEv.gate
      tags.push(`<span class="tag gate">gate ${g.speak ? "<b>open</b>" : "closed"}</span>`)
      for (const [k, label] of Object.entries(GATE)) tags.push(`<span class="tag gate ${g.reasons[k] ? "pass" : "fail"}">${g.reasons[k] ? "✓" : "✗"} ${label}</span>`)
    }
    const rows = []
    if (main?.verdict === "supports") rows.push(`<div class="sub-row quiet"><b>Stays quiet:</b> the claim checks out. No LLM call.</div>`)
    for (const e of l.events) {
      if (e.agent?.action === "dispatched") rows.push(`<div class="sub-row agent"><b>⚙ LLM agent, task ${e.agent.task}:</b> ${e.agent.job === "confirm" ? "verify before interrupting" : "answer the question"}. ${esc(e.agent.detail)}</div>`)
      if (e.agent?.action === "reported") rows.push(`<div class="sub-row agent"><b>✓ Task ${e.agent.task} reported${e.agent.ms ? ` in ${secs(e.agent.ms)}` : ""}</b> (${esc(e.agent.by ?? "")}): ${esc(e.agent.detail)}</div>`)
      if (e.note && !e.said) rows.push(`<div class="sub-row ${/Staying quiet|not finished|not an instruction|stays out/i.test(e.note) ? "quiet" : "note"}">${/Staying quiet|not finished|not an instruction/i.test(e.note) ? "<b>Stays quiet:</b> " : ""}${esc(e.note)}</div>`)
      if (e.request?.state === "dropped") rows.push(`<div class="sub-row quiet"><b>Stays quiet:</b> ${esc(e.request.speaker)}'s question; ${esc(e.request.note)}.</div>`)
      if (e.said) rows.push(`<div class="sub-row egg"><span class="k">${esc(KIND_LABEL[e.saidKind] ?? "said")}</span><b>Egg Head:</b> ${esc(e.said)}${e.note ? `<div class="dim" style="color:#cdb67a;font-size:12px;margin-top:3px">${esc(e.note)}</div>` : ""}</div>`)
    }
    const text = l.cut ? `${esc(l.cut)}—` : esc(l.text)
    return `<div class="t-line"><div class="t-time">${clock(l.at)}</div><div>
      <span class="t-who"><i style="background:${colors[l.speaker] ?? "#888"}"></i>${esc(l.speaker)}</span><span class="t-text${l.cut ? " cut" : ""}">${text}</span>
      ${tags.length ? `<div class="trig">${tags.join("")}</div>` : ""}${rows.join("")}</div></div>`
  }).join("")
  if (s.running && nearBottom) window.scrollTo(0, document.body.scrollHeight)
}

function renderChecks(s) {
  const claims = [...s.claims.values()]
  if (!claims.length) return
  $("checks").innerHTML = `<table><tr><th>Claim</th><th>Check</th><th>Outcome</th></tr>${claims.map((c) => `
    <tr><td><b>${esc(c.speaker)}:</b> ${esc(c.text)}</td>
    <td>${esc(c.check)} · ${esc(c.resource)}<span class="dim">${esc(c.evidence ?? "")}</span></td>
    <td><span class="state ${c.state}">${CLAIM_STATE[c.state] ?? c.state}</span></td></tr>`).join("")}</table>`
}

function renderTasks(s) {
  const tasks = [...s.tasks.values()]
  if (!tasks.length) return
  $("tasks").innerHTML = `<table><tr><th>#</th><th>Why it ran</th><th>Took</th><th>Result</th></tr>${tasks.map((t) => `
    <tr><td>${t.task}</td>
    <td>${t.job === "confirm" ? "Verify a wrong claim before interrupting" : "Answer a question"}<span class="dim">${esc(t.detail ?? "")}</span></td>
    <td class="n">${t.ms ? secs(t.ms) : t.state === "running" ? "running…" : "–"}</td>
    <td>${esc(t.result ?? "")}<span class="dim">${esc(t.by ?? "")}</span></td></tr>`).join("")}</table>`
}

function renderQuestions(s) {
  const reqs = [...s.requests.values()]
  if (!reqs.length) return
  $("questions").innerHTML = `<table><tr><th>Asked</th><th>To</th><th>Outcome</th></tr>${reqs.map((r) => `
    <tr><td><b>${esc(r.speaker)}:</b> ${esc(r.text)}${r.answer ? `<span class="dim">Egg Head: ${esc(r.answer)}</span>` : ""}</td>
    <td>${r.kind === "addressed" ? "Egg Head" : "the call"}</td>
    <td><span class="state ${r.state}">${REQUEST_STATE[r.state] ?? r.state}</span><span class="dim">${esc(r.note)}</span></td></tr>`).join("")}</table>`
}

function renderQuiet(s) {
  if (!s.quiet.length) return
  $("quiet").innerHTML = s.quiet.map((q) => `<div><span>${clock(q.at)}</span>${esc(q.why)}</div>`).join("")
}

$("start").onclick = () => {
  $("start").disabled = true
  fetch("/start", { method: "POST" })
}
connect(store)
