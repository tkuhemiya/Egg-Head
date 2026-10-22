// The run dashboard: the meeting transcript with what each line triggered (Decider, the fast
// check, the gate, the LLM agent, what Egg Head said or why it stayed quiet), plus the checks,
// agent tasks and questions of the run. Live, or the last run with ?replay.
import { personOf } from "./avatars.js"
import { flash, pop, reconcile, roll, shake } from "./motion.js"
import { connect, createStore, esc, secs } from "./store.js"
import { createTree, trace } from "./tree.js"

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

// The tree follows the latest line until you pick one; "Whole run" counts every line, and a node
// clicked there marks the lines that went through it.
const view = { mode: "line", picked: null, focus: null }
const tree = createTree($("tree"), {
  onNode: (id) => {
    view.mode = "run"
    view.focus = view.focus === id ? null : id
    render(store.get())
    const first = $("transcript").querySelector(".t-line.hit")
    if (first) $("transcript").scrollTo({ top: first.offsetTop - $("transcript").offsetTop - 8, behavior: "smooth" })
  }
})
const decided = (s) => s.lines.filter((l) => l?.speaker && trace(s, l).size)
// following live: the newest line that set something going (a claim or a question), so a claim
// stays up while the agent checks it and the gate waits, instead of jumping to small talk
const shown = (s) => {
  if (view.picked !== null) return view.picked
  const ls = decided(s)
  return (ls.findLast((l) => !trace(s, l).has("nothing")) ?? ls.at(-1))?.index ?? null
}
const pick = (index) => {
  view.picked = index
  view.mode = "line"
  view.focus = null
  render(store.get())
}
const step = (d) => {
  const ls = decided(store.get()).map((l) => l.index)
  const at = ls.indexOf(shown(store.get()))
  if (ls.length) pick(ls[Math.max(0, Math.min(ls.length - 1, (at < 0 ? ls.length : at) + d))])
}
$("prev").onclick = () => step(-1)
$("next").onclick = () => step(1)
addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") (e.preventDefault(), step(e.key === "ArrowLeft" ? -1 : 1))
  if (e.key === "Escape") pick(null)
})
$("follow").onclick = () => pick(null)
$("transcript").addEventListener("click", (e) => {
  const el = e.target.closest(".t-line")
  if (el) pick(Number(el.dataset.key.slice(1)))
})
for (const b of $("seg").querySelectorAll("button")) {
  b.onclick = () => {
    view.mode = b.dataset.mode
    view.focus = null
    render(store.get())
  }
}
function renderSeg() {
  const seg = $("seg")
  for (const b of seg.querySelectorAll("button")) b.classList.toggle("on", b.dataset.mode === view.mode)
  const on = seg.querySelector("button.on")
  seg.querySelector("i").style.cssText = `left:${on.offsetLeft}px;width:${on.offsetWidth}px`
}

const plural = (k, w) => `${k} ${w}${k === 1 ? "" : "s"}`

function renderTree(s) {
  renderSeg()
  const index = view.mode === "line" ? shown(s) : null
  tree.update(s, index, view.focus)
  const l = index === null ? null : s.lines[index]
  const what = view.mode === "run"
    ? view.focus ? `${plural(tree.linesThrough(s, view.focus).size, "line")} went this way · click it again to clear` : `${plural(decided(s).length, "line")} · click a node to see which`
    : l ? `<span>${clock(l.at)}</span><b>${esc(l.speaker)}</b>${esc(l.cut ? `${l.cut}—` : l.text)}` : "Pick a line in the transcript"
  if ($("what")._w !== what) ($("what").innerHTML = what, $("what")._w = what)
  $("follow").classList.toggle("on", view.mode === "line" && view.picked === null)
  $("follow").textContent = view.mode === "line" && view.picked === null ? "following live" : view.mode === "line" ? "esc: follow live" : ""
}

function render(s) {
  $("live").classList.toggle("on", s.running)
  renderTree(s)
  renderKpis(s)
  renderTranscript(s)
  renderChecks(s)
  renderTasks(s)
  renderQuestions(s)
  renderQuiet(s)
}

function renderKpis(s) {
  const st = s.stats
  const kpi = (id, n) => {
    const el = $(id)
    const was = el._roll
    roll(el, n)
    if (was !== undefined && was !== el._roll && n > 0) flash(el.parentElement, "rgba(255,255,255,.18)")
  }
  kpi("k-lines", s.lines.filter((l) => l?.speaker).length)
  kpi("k-wrong", s.checks.filter((c) => c.verdict === "contradicts").length)
  kpi("k-spoke", s.egg.length)
  kpi("k-quiet", s.quiet.length)
  kpi("k-llm", st ? st.agentTasks + st.bedrockCalls : 0)
}

/** Keyed rows into a section: `head` stays, rows come and go with motion.js. */
function rows(box, head, items, onChange) {
  let body = box.querySelector("tbody")
  if (!body) {
    box.innerHTML = `<table><thead>${head}</thead><tbody></tbody></table>`
    body = box.querySelector("tbody")
  }
  reconcile(body, items.map((i) => ({ ...i, tag: "tr", cls: "" })), { onChange })
}

// a state that turned out wrong shakes its row; one that resolved settles with a flash
const BAD = new Set(["contradicted", "confirmed", "failed"])
const settle = (el, added) => {
  const st = added.find((a) => a.classList.contains("state"))
  if (!st) return
  flash(st)
  if (BAD.has(st.dataset.k)) shake(st, { intensity: 5, count: 5, rotate: 3 })
}

function renderTranscript(s) {
  const lines = s.lines.filter((l) => l?.speaker)
  if (!lines.length) return
  const box = $("transcript")
  box.querySelector(".empty")?.remove()
  const nearBottom = box.scrollTop + box.clientHeight > box.scrollHeight - 80
  const through = view.mode === "run" && view.focus ? tree.linesThrough(s, view.focus) : null
  reconcile(box, lines.map((l) => {
    const main = l.events.find((e) => e.speaker === l.speaker && e.route)
    const req = main && l.events.find((e) => e.request && e.request.turn === main.turn)?.request
    const tags = []
    if (main?.verdict === "contradicts") tags.push(`<span class="tag bad" data-k="bad">✗ wrong: ${esc(main.checkEvidence)}</span>`)
    if (main?.verdict === "supports") tags.push(`<span class="tag good" data-k="good">✓ checks out</span>`)
    if (req?.kind === "addressed" && req.note?.startsWith("asked")) tags.push(`<span class="tag ask" data-k="ask">asks Egg Head</span>`)
    if (req?.kind === "open") tags.push(`<span class="tag ask" data-k="open">question to the call</span>`)
    const rows = []
    l.events.forEach((e, k) => {
      if (e.agent?.action === "reported") {
        rows.push(`<div class="sub-row agent" data-k="a${k}"><b>Agent:</b> ${esc(e.agent.detail.replace(/^confirmed: /, ""))}</div>`)
      }
      if (e.said) rows.push(`<div class="sub-row egg" data-k="s${k}"><b>Egg Head:</b> ${esc(e.said)}</div>`)
    })
    s.quiet.forEach((q, k) => q.index === l.index && rows.push(`<div class="sub-row quiet" data-k="q${k}"><b>Stayed quiet</b> ${esc(q.why)}</div>`))
    const text = l.cut ? `${esc(l.cut)}—` : esc(l.text)
    const sel = view.mode === "line" && shown(s) === l.index ? " sel" : ""
    const hit = through ? (through.has(l.index) ? " hit" : " dim") : ""
    return {
      key: `l${l.index}`,
      cls: `t-line${sel}${hit}`,
      html: `<div class="t-time">${clock(l.at)}</div><div>
      <span class="t-who"><i style="background:${colors[l.speaker] ?? "#888"}"></i>${esc(l.speaker)}</span><span class="t-text${l.cut ? " cut" : ""}">${text}</span>
      ${tags.length ? `<div class="trig">${tags.join("")}</div>` : ""}${rows.join("")}</div>`
    }
  }), {
    onChange: (el, added) => {
      for (const a of added) {
        if (a.classList.contains("bad")) (shake(el, { intensity: 5, count: 5, rotate: .6 }), flash(el, "rgba(239,68,68,.35)"))
        if (a.classList.contains("egg")) setTimeout(() => (pop(a, 0.92), flash(a, "rgba(245,200,76,.5)")), 80)
      }
    }
  })
  if (s.running && nearBottom) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" })
}

function renderChecks(s) {
  const claims = [...s.claims.values()]
  if (!claims.length) return
  rows($("checks"), "<tr><th>Claim</th><th>Live data</th><th>Outcome</th></tr>", claims.map((c) => ({
    key: `c${c.turn}`,
    html: `<td><b>${esc(c.speaker)}:</b> ${esc(c.text)}</td>
    <td>${esc(c.resource)}<span class="dim">${esc(c.evidence ?? "")}</span></td>
    <td><span class="state ${c.state}${c.state === "checking" ? " running" : ""}" data-k="${c.state}">${CLAIM_STATE[c.state] ?? c.state}</span></td>`
  })), settle)
}

function renderTasks(s) {
  const tasks = [...s.tasks.values()]
  if (!tasks.length) return
  rows($("tasks"), "<tr><th>Task</th><th>Took</th><th>Found</th></tr>", tasks.map((t) => ({
    key: `t${t.task}`,
    html: `<td>${t.job === "confirm" ? `Check ${esc(t.detail?.split(":")[0])}'s claim` : "Answer a question"}</td>
    <td class="n">${t.ms ? `<span class="state done" data-k="done">${secs(t.ms)}</span>` : t.state === "running" ? '<span class="state running" data-k="running">running</span>' : t.state === "failed" ? '<span class="state failed" data-k="failed">failed</span>' : "–"}</td>
    <td>${esc((t.result ?? "").replace(/^confirmed: /, ""))}</td>`
  })), settle)
}

function renderQuestions(s) {
  const reqs = [...s.requests.values()]
  if (!reqs.length) return
  rows($("questions"), "<tr><th>Asked</th><th>To</th><th>Outcome</th></tr>", reqs.map((r) => ({
    key: `r${r.id}`,
    html: `<td><b>${esc(r.speaker)}:</b> ${esc(r.text)}${r.answer ? `<span class="dim">Egg Head: ${esc(r.answer)}</span>` : ""}</td>
    <td>${r.kind === "addressed" ? "Egg Head" : "the call"}</td>
    <td><span class="state ${r.state}${r.state === "checking" ? " running" : ""}" data-k="${r.state}">${REQUEST_STATE[r.state] ?? r.state}</span></td>`
  })), settle)
}

function renderQuiet(s) {
  if (!s.quiet.length) return
  $("quiet").querySelector(".empty")?.remove()
  reconcile($("quiet"), s.quiet.map((q, i) => ({ key: `q${i}`, cls: "", html: `<span>${clock(q.at)}</span>${esc(q.why)}` })))
}

$("start").onclick = () => {
  pop($("start"), 0.9)
  $("start").disabled = true
  fetch("/start", { method: "POST" })
}
connect(store)
