// The run dashboard: the meeting transcript with what each line triggered (Decider, the fast
// check, the gate, the LLM agent, what Egg Head said or why it stayed quiet), plus the checks,
// agent tasks and questions of the run. Live, or the last run with ?replay.
import { personOf } from "./avatars.js"
import { connect, createStore, esc, secs } from "./store.js"

const $ = (id) => document.getElementById(id)
const cfg = await fetch("/config").then((r) => r.json())
$("title").textContent = cfg.title
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
  const st = s.stats
  $("k-lines").textContent = s.lines.filter((l) => l?.speaker).length
  $("k-wrong").textContent = s.checks.filter((c) => c.verdict === "contradicts").length
  $("k-spoke").textContent = s.egg.length
  $("k-quiet").textContent = s.quiet.length
  $("k-llm").textContent = st ? st.agentTasks + st.bedrockCalls : 0
}

function renderTranscript(s) {
  const lines = s.lines.filter((l) => l?.speaker)
  if (!lines.length) return
  const box = $("transcript")
  const nearBottom = window.innerHeight + window.scrollY > document.body.scrollHeight - 80
  box.innerHTML = lines.map((l) => {
    const main = l.events.find((e) => e.speaker === l.speaker && e.route)
    const req = main && l.events.find((e) => e.request && e.request.turn === main.turn)?.request
    const tags = []
    if (main?.verdict === "contradicts") tags.push(`<span class="tag bad">✗ wrong: ${esc(main.checkEvidence)}</span>`)
    if (main?.verdict === "supports") tags.push(`<span class="tag good">✓ checks out</span>`)
    if (req?.kind === "addressed" && req.note?.startsWith("asked")) tags.push(`<span class="tag ask">asks Egg Head</span>`)
    if (req?.kind === "open") tags.push(`<span class="tag ask">question to the call</span>`)
    const rows = []
    for (const e of l.events) {
      if (e.agent?.action === "reported") {
        rows.push(`<div class="sub-row agent"><b>Agent:</b> ${esc(e.agent.detail.replace(/^confirmed: /, ""))}</div>`)
      }
      if (e.said) rows.push(`<div class="sub-row egg"><b>Egg Head:</b> ${esc(e.said)}</div>`)
    }
    for (const q of s.quiet.filter((q) => q.index === l.index)) rows.push(`<div class="sub-row quiet"><b>Stayed quiet:</b> ${esc(q.why)}</div>`)
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
  $("checks").innerHTML = `<table><tr><th>Claim</th><th>Live data</th><th>Outcome</th></tr>${claims.map((c) => `
    <tr><td><b>${esc(c.speaker)}:</b> ${esc(c.text)}</td>
    <td>${esc(c.resource)}<span class="dim">${esc(c.evidence ?? "")}</span></td>
    <td><span class="state ${c.state}">${CLAIM_STATE[c.state] ?? c.state}</span></td></tr>`).join("")}</table>`
}

function renderTasks(s) {
  const tasks = [...s.tasks.values()]
  if (!tasks.length) return
  $("tasks").innerHTML = `<table><tr><th>Task</th><th>Took</th><th>Found</th></tr>${tasks.map((t) => `
    <tr><td>${t.job === "confirm" ? `Check ${esc(t.detail?.split(":")[0])}'s claim` : "Answer a question"}</td>
    <td class="n">${t.ms ? secs(t.ms) : t.state === "running" ? "running…" : "–"}</td>
    <td>${esc((t.result ?? "").replace(/^confirmed: /, ""))}</td></tr>`).join("")}</table>`
}

function renderQuestions(s) {
  const reqs = [...s.requests.values()]
  if (!reqs.length) return
  $("questions").innerHTML = `<table><tr><th>Asked</th><th>To</th><th>Outcome</th></tr>${reqs.map((r) => `
    <tr><td><b>${esc(r.speaker)}:</b> ${esc(r.text)}${r.answer ? `<span class="dim">Egg Head: ${esc(r.answer)}</span>` : ""}</td>
    <td>${r.kind === "addressed" ? "Egg Head" : "the call"}</td>
    <td><span class="state ${r.state}">${REQUEST_STATE[r.state] ?? r.state}</span></td></tr>`).join("")}</table>`
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
