// The run dashboard: the meeting transcript with what each line triggered (Decider, the fast
// check, the gate, the LLM agent, what Egg Head said or why it stayed quiet), plus the checks,
// agent tasks and questions of the run. Live, or the last run with ?replay.
import { personOf } from "./avatars.js"
import { flash, pop, reconcile, shake } from "./motion.js"
import { connect, createStore, esc, secs } from "./store.js"
import { createTree, trace } from "./tree.js"

const $ = (id) => document.getElementById(id)
const cfg = await fetch("/config").then((r) => r.json())
const colors = Object.fromEntries(cfg.people.map((p, i) => [p, personOf(p, i).accentC]))
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

const CLAIM_STATE = {
  contradicted: "contradicted",
  checking: "looking it up",
  confirmed: "confirmed, waiting for a gap",
  raised: "raised",
  barged: "cut in",
  corrected: "the call corrected it",
  true: "true",
  overruled: "the look-up agreed with them",
  parked: "parked by the call"
}
const REQUEST_STATE = { listening: "listening", checking: "looking it up", ready: "answer ready", answered: "answered", dropped: "the call answered" }

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

const view = { picked: null, focus: null }
const tree = createTree($("tree"), {
  onNode: (id) => {
    view.focus = view.focus === id ? null : id
    if (view.focus) view.picked = null
    render(store.get())
    const first = $("transcript").querySelector(".t-line.hit")
    if (first) $("transcript").scrollTo({ top: first.offsetTop - $("transcript").offsetTop - 8, behavior: "smooth" })
  }
})
const decided = (s) => s.lines.filter((l) => l?.speaker && trace(s, l).size)
const shown = (s) => {
  if (view.picked !== null) return view.picked
  const ls = decided(s)
  return (ls.findLast((l) => !trace(s, l).has("nothing")) ?? ls.at(-1))?.index ?? null
}
const pick = (index) => {
  view.picked = index
  view.focus = null
  render(store.get())
}
$("transcript").addEventListener("click", (e) => {
  const el = e.target.closest(".t-line")
  if (el) pick(Number(el.dataset.key.slice(1)))
})
addEventListener("keydown", (e) => {
  if (e.key === "Escape") pick(null)
})

function renderTree(s) {
  tree.update(s, view.focus ? null : shown(s), view.focus)
}

function render(s) {
  $("live").classList.toggle("on", s.running)
  renderTree(s)
  renderTranscript(s)
  renderMoment(s)
}

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
  const through = view.focus ? tree.linesThrough(s, view.focus) : null
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
        rows.push(`<div class="sub-row egg" data-k="a${k}"><b>Egg Head:</b> ${esc((e.agent.detail ?? "").replace(/^confirmed: /, ""))}</div>`)
      }
      if (e.said) rows.push(`<div class="sub-row egg" data-k="s${k}"><b>Egg Head:</b> ${esc(e.said)}</div>`)
    })
    s.quiet.forEach((q, k) => q.index === l.index && rows.push(`<div class="sub-row quiet" data-k="q${k}"><b>Stayed quiet</b> ${esc(q.why)}</div>`))
    const text = l.cut ? `${esc(l.cut)}—` : esc(l.text)
    const sel = !view.focus && shown(s) === l.index ? " sel" : ""
    const hit = through ? (through.has(l.index) ? " hit" : " dim") : ""
    return {
      key: `l${l.index}`,
      cls: `t-line${sel}${hit}`,
      html: `<div class="t-time">${clock(l.at)}</div><div class="t-rail"><i></i></div><div>
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

function renderMoment(s) {
  const box = $("moment")
  if (view.focus) {
    const info = tree.inspect(view.focus)
    const n = tree.linesThrough(s, view.focus).size
    $("moment-h").textContent = info?.label ?? view.focus
    const choices = (info?.choices ?? []).map((c) => `<span class="choice">${esc(c)}</span>`).join("")
    const layers = (info?.layers ?? []).map((c) => `<li>${esc(c)}</li>`).join("")
    const line = shown(s) === null ? null : s.lines[shown(s)]
    const here = line ? trace(s, line).get(view.focus) : null
    box.innerHTML = `<div class="fact">
      <div class="k">${esc(info?.typeLabel ?? "Step")}</div>
      <p>${esc(info?.ask ?? "")}</p>
      ${info?.threshold !== undefined ? `<p class="dim">fires at ≥ ${info.threshold}</p>` : ""}
      ${layers ? `<ul class="layers">${layers}</ul>` : ""}
      ${choices ? `<div style="margin-top:10px">${choices}</div>` : ""}
      ${here ? `<p class="dim" style="margin-top:12px">This line · ${esc(String(here.state))}${here.meta ? ` · ${here.meta.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}` : ""}</p>` : ""}
      <p class="dim">${n} line${n === 1 ? "" : "s"} this run</p>
    </div>`
    return
  }
  const i = shown(s)
  const l = i === null ? null : s.lines[i]
  $("moment-h").textContent = l ? `${clock(l.at)} · ${l.speaker}` : "On this line"
  if (!l) {
    box.innerHTML = `<div class="empty">Pick a line, or a node in the tree.</div>`
    return
  }
  const answer = (r) => (r.answer && typeof r.answer === "object" ? r.answer.value : r.answer)
  const items = []
  for (const c of s.claims.values()) {
    if (c.index !== l.index) continue
    items.push({
      key: `c${c.turn}`,
      cls: "fact",
      html: `<div class="k">Claim</div><p><b>${esc(c.speaker)}</b> ${esc(c.text)}</p>
        <p class="dim">${esc(c.resource)}${c.evidence ? ` · ${esc(c.evidence)}` : ""}</p>
        <span class="state ${c.state}${c.state === "checking" ? " running" : ""}" data-k="${c.state}">${CLAIM_STATE[c.state] ?? c.state}</span>`
    })
  }
  for (const t of s.tasks.values()) {
    if (t.index !== l.index) continue
    const st = t.ms ? '<span class="state done" data-k="done">' + secs(t.ms) + "</span>"
      : t.state === "running" ? '<span class="state running" data-k="running">looking</span>'
      : t.state === "failed" ? '<span class="state done" data-k="done">found</span>' : ""
    const title = t.job === "confirm" ? "Checking " + esc((t.detail ?? "").split(":")[0]) + "'s claim" : "Answering a question"
    const found = t.result ? "<p>" + esc(t.result.replace(/^confirmed: /, "")) + "</p>" : ""
    items.push({
      key: "t" + t.task,
      cls: "fact",
      html: '<div class="k">Look-up</div><p>' + title + " " + st + "</p>" + found
    })
  }
  for (const r of s.requests.values()) {
    if (r.index !== l.index) continue
    const a = answer(r)
    items.push({
      key: `r${r.id}`,
      cls: "fact",
      html: `<div class="k">Question</div><p><b>${esc(r.speaker)}</b> ${esc(r.text)}</p>
        <p class="dim">${r.kind === "addressed" ? "to Egg Head" : "to the call"}</p>
        <span class="state ${r.state}${r.state === "checking" ? " running" : ""}" data-k="${r.state}">${REQUEST_STATE[r.state] ?? r.state}</span>
        ${a ? `<p class="dim">Egg Head: ${esc(a)}</p>` : ""}`
    })
  }
  s.quiet.forEach((q, n) => {
    if (q.index !== l.index) return
    items.push({ key: `q${n}`, cls: "fact", html: `<div class="k">Stayed quiet</div><p>${esc(q.why)}</p>` })
  })
  if (!items.length) {
    box.innerHTML = `<div class="empty">Nothing extra on this line.</div>`
    return
  }
  box.querySelector(".empty")?.remove()
  reconcile(box, items, { onChange: settle })
}

$("start").onclick = () => {
  pop($("start"), 0.9)
  $("start").disabled = true
  fetch("/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
}
connect(store)
