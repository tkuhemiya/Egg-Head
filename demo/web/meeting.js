// The meeting page: cartoon teammates who lip-sync to their Polly voices, your camera, Egg Head
// with what it is doing right now, its coding agent's live terminal, and a feed of every decision.
import { drawEggHead, drawPerson, personOf } from "./avatars.js"
import { connect, createStore, eggState, esc, KIND_LABEL, pct, secs } from "./store.js"

const $ = (id) => document.getElementById(id)
const h = (tag, cls, html) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}
const params = new URLSearchParams(location.search)
const me = params.get("me") || "You"
const cfg = await fetch("/config").then((r) => r.json())
$("title").textContent = `Incident bridge · ${cfg.title}`
$("agent-label").textContent = cfg.agent === "none" ? "no agent in this run" : cfg.agent
if (cfg.rehearsal) $("note").textContent = "Rehearsal: scripted Decider and model"
// ?term=30%&busy=60%: terminal height when idle, and while the agent works (it grows so its commands show)
if (params.has("term")) document.documentElement.style.setProperty("--term-h", params.get("term"))
if (params.has("busy")) document.documentElement.style.setProperty("--term-busy", params.get("busy"))

const MIC_ON = '<svg class="mic-on" viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2z"/></svg>'
const MIC_OFF = '<svg class="mic-off" viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2zM3.3 2.3 2 3.6l18.4 18.4 1.3-1.3z"/></svg>'

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

const tiles = new Map() // name -> { tile, toon, badge }
const grid = $("grid")

function tile(name, cls = "") {
  const t = h("div", `tile ${cls}`)
  const p = personOf(name, tiles.size)
  if (p.bg && !cls.includes("egg")) t.style.cssText = `--bg1:${p.bg[0]};--bg2:${p.bg[1]}`
  const art = h("div", "art")
  const badge = h("div", "badge")
  const label = h("div", "name", `${cls.includes("me") ? MIC_OFF : MIC_ON}<span>${esc(name)}</span>${p.role && !cls ? `<span class="role">${esc(p.role)}</span>` : ""}`)
  t.append(art, badge, label)
  grid.insertBefore(t, $("captions"))
  return { t, art, badge, label }
}

// You: your camera only (never the microphone)
const mine = tile(me, "me")
mine.label.innerHTML = `${MIC_OFF}<span>${esc(me)}</span><span class="role">presenting</span>`
const video = h("video")
video.autoplay = video.muted = video.playsInline = true
const nocam = h("div", "nocam", `<div><b>${esc(me.slice(0, 1).toUpperCase())}</b>Camera off</div>`)
mine.art.replaceWith(video)
mine.t.append(nocam)
let stream = null
async function camera(on) {
  if (!on) {
    stream?.getTracks().forEach((t) => t.stop())
    stream = null
    nocam.style.display = ""
    $("cam-btn").classList.add("off")
    return
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
    video.srcObject = stream
    nocam.style.display = "none"
    $("cam-btn").classList.remove("off")
  } catch {
    nocam.style.display = ""
    $("cam-btn").classList.add("off")
  }
}
$("cam-btn").onclick = () => camera(!stream)
if (!params.has("nocam")) camera(true)
else $("cam-btn").classList.add("off")

cfg.people.forEach((name, i) => {
  const t = tile(name)
  const toon = drawPerson(name, i)
  t.art.append(toon.svg)
  tiles.set(name, { ...t, toon })
})

const egg = tile("Egg Head", "egg")
egg.label.innerHTML = `${MIC_ON}<span>Egg Head</span><span class="role">AI teammate</span>`
const eggToon = drawEggHead()
egg.art.append(eggToon.svg)
const mind = h("div", "mind", '<div class="state listening" id="egg-state"><i></i><span>Ready</span></div><div class="detail" id="egg-detail"></div><div class="said" id="egg-said"></div>')
egg.t.append(mind)
tiles.set("Egg Head", { ...egg, toon: eggToon })
$("mini").append(drawEggHead().svg)

// ---------------------------------------------------------------------------
// Audio, lips and captions
// ---------------------------------------------------------------------------

let audioOn = false
const playing = new Map() // line index -> Audio
const play = (src) => {
  if (!audioOn) return null
  const a = new Audio(src)
  a.play().catch(() => {})
  return a
}

let captionTimers = []
function caption(name, marks, durationS, isEgg, text) {
  captionTimers.forEach(clearTimeout)
  captionTimers = []
  const box = $("captions")
  box.className = `captions on${isEgg ? " egg" : ""}`
  const words = marks?.words?.length ? marks.words : null
  if (!words) {
    box.innerHTML = `<b>${esc(name)}</b>${esc(text)}`
  } else {
    box.innerHTML = `<b>${esc(name)}</b>`
    words.forEach((w, k) => captionTimers.push(setTimeout(() => {
      box.innerHTML = `<b>${esc(name)}</b>${esc(words.slice(0, k + 1).map((x) => x.value).join(" "))}`
    }, w.time)))
  }
  captionTimers.push(setTimeout(() => box.classList.remove("on"), durationS * 1000 + 1400))
}
function cutCaption(name, text) {
  captionTimers.forEach(clearTimeout)
  captionTimers = []
  $("captions").className = "captions on"
  $("captions").innerHTML = `<b>${esc(name)}</b>${esc(text)}—`
}

const speaking = (name, on, ms = 0) => {
  const t = tiles.get(name)
  if (!t) return
  t.t.classList.toggle("speaking", on)
  if (on && ms) setTimeout(() => t.t.classList.remove("speaking"), ms)
}
const badge = (name, text, cls, ms = 2500) => {
  const t = tiles.get(name)
  if (!t) return
  t.badge.className = `badge on ${cls}`
  t.badge.textContent = text
  if (ms) setTimeout(() => t.badge.classList.remove("on"), ms)
}

// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------

const term = new window.Terminal({
  fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
  fontSize: Number(params.get("font") ?? 12),
  lineHeight: 1.1,
  cursorBlink: false,
  disableStdin: true,
  scrollback: 4000,
  theme: { background: "#0e0e12", foreground: "#e6e6ee", cursor: "#8b8cf7", selectionBackground: "#3a3a55" }
})
const fit = new window.FitAddon.FitAddon()
term.loadAddon(fit)
term.open($("screen"))
const resize = () => {
  try { fit.fit() } catch {}
  fetch("/pty/resize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cols: term.cols, rows: term.rows }) })
}
new ResizeObserver(() => { clearTimeout(resize.t); resize.t = setTimeout(resize, 450) }).observe($("screen"))
resize()
new EventSource("/pty").onmessage = (e) => term.write(JSON.parse(e.data).d)

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

const store = createStore()
let clockBase = null // { at: ms into the run (server), t: when it arrived here }
setInterval(() => {
  if (!clockBase) return
  const s = Math.floor((clockBase.at + Date.now() - clockBase.t) / 1000)
  $("timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
}, 500)

// Messages replayed when the page connects mid-run are state only: no voices, lips or captions.
let live = false
store.subscribe((s, m) => {
  if (m.at !== undefined && s.running) clockBase = { at: m.at, t: Date.now() }
  if (!live && ["line", "cut", "egghead"].includes(m.type)) m = { type: "skip" }
  switch (m.type) {
    case "reset":
      $("feed").innerHTML = ""
      break
    case "meta":
      $("live").classList.add("on")
      break
    case "line": {
      tiles.forEach((_, name) => speaking(name, false))
      speaking(m.speaker, true, m.durationS * 1000)
      tiles.get(m.speaker)?.toon.say(m.marks, m.durationS)
      playing.set(m.index, play(m.audio))
      caption(m.speaker, m.marks, m.durationS, false, m.text)
      break
    }
    case "cut": {
      playing.get(m.index)?.pause()
      tiles.get(m.speaker)?.toon.stop()
      speaking(m.speaker, false)
      badge(m.speaker, "interrupted by Egg Head", "cut")
      cutCaption(m.speaker, m.text)
      break
    }
    case "egghead":
      eggSpeakingUntil = Date.now() + m.durationS * 1000
      setTimeout(() => renderEgg(store.get()), m.durationS * 1000 + 50)
      speaking("Egg Head", true, m.durationS * 1000)
      eggToon.say(m.marks, m.durationS)
      play(m.audio)
      caption("Egg Head", m.marks, m.durationS, true, m.text)
      $("egg-said").textContent = `“${m.text}”`
      break
    case "done":
      $("live").classList.remove("on")
      clockBase = null
      $("start").disabled = false
      $("start").textContent = "Run again"
      break
    case "event": {
      const r = m.event.request
      if (r && r.kind === "addressed" && r.state === "listening") badge(r.speaker, "talking to Egg Head", "ask", 0)
      if (r && r.state !== "listening") tiles.get(r.speaker)?.badge.classList.remove("on")
      break
    }
  }
  renderEgg(s)
  renderStats(s)
  renderFeed(s)
  $("status").textContent = s.done ? "" : s.status
})

let eggSpeakingUntil = 0
function renderEgg(s) {
  const st = Date.now() < eggSpeakingUntil ? { key: "floor", text: "Speaking" } : eggState(s)
  $("egg-state").className = `state ${st.key}`
  $("egg-state").querySelector("span").textContent = st.text
  eggToon.svg.classList.toggle("thinking", st.key === "checking")
  const running = [...s.tasks.values()].find((t) => t.state === "running")
  const listening = [...s.requests.values()].find((r) => r.state === "listening" && r.kind === "addressed")
  const confirmed = [...s.claims.values()].find((c) => c.state === "confirmed")
  const ready = [...s.requests.values()].find((r) => r.state === "ready")
  $("egg-detail").textContent = running
    ? (running.job === "confirm" ? `Verifying ${running.detail}` : `Looking up: ${running.detail}`)
    : listening ? listening.note
    : confirmed ? `${confirmed.speaker}'s claim is wrong. Raising it when there is a gap.`
    : ready ? `Answer for ${ready.speaker} ready. Waiting for a gap.`
    : s.hold ? "The call is giving Egg Head the floor."
    : ""
  const busy = !!running
  // the terminal grows while the agent works, and stays big a moment after it reports
  if (busy) {
    clearTimeout(renderEgg.shrink)
    renderEgg.shrink = 0
    document.body.classList.add("agent-busy")
  } else if (document.body.classList.contains("agent-busy") && !renderEgg.shrink) {
    renderEgg.shrink = setTimeout(() => {
      renderEgg.shrink = 0
      document.body.classList.remove("agent-busy")
    }, 3000)
  }
  $("agent-pill").className = `pill${busy ? " busy" : ""}`
  $("agent-pill").textContent = busy ? `task ${running.task} running` : `${s.tasks.size} task${s.tasks.size === 1 ? "" : "s"} done`
}

function renderStats(s) {
  const st = s.stats
  if (!st) return
  $("s-decider").textContent = st.deciderBatches ? `${st.deciderMsP50} ms` : "–"
  $("s-llm").textContent = st.agentTasks + st.bedrockCalls
  $("s-every").textContent = st.lines
}

let feedTouched = 0
$("feed").addEventListener("wheel", () => (feedTouched = Date.now()), { passive: true })

/** One feed, oldest first: lines with what Decider made of them, Egg Head, the agent, the quiet calls. */
function renderFeed(s) {
  const items = []
  for (const l of s.lines) {
    if (!l?.speaker) continue
    const main = l.events.find((e) => e.speaker === l.speaker && e.route)
    const chips = []
    if (main) {
      const rt = main.route
      const claim = rt.scores?.claim
      chips.push(`<span class="chip">Decider <b>${Math.round(main.deciderMs)} ms</b></span>`)
      if (rt.action === "check" && main.verdict) {
        chips.push(`<span class="chip info">claim ${pct(claim)} → ${esc(rt.check)} · ${esc(rt.resource)}</span>`)
        chips.push(main.verdict === "contradicts" ? `<span class="chip bad">✗ contradicted</span>` : main.verdict === "supports" ? `<span class="chip good">✓ true</span>` : `<span class="chip">inconclusive</span>`)
      } else if (rt.action === "escalate") chips.push(`<span class="chip info">claim ${pct(claim)}, could not route</span>`)
      else chips.push(`<span class="chip">not a claim</span>`)
      const req = l.events.find((e) => e.request && e.request.turn === main.turn)?.request
      if (req?.kind === "addressed") chips.push(`<span class="chip ask">talking to Egg Head ${pct(main.gateScores?.addressed)}</span>`)
      if (req?.kind === "open") chips.push(`<span class="chip ask">question to the call ${pct(main.gateScores?.asks)}</span>`)
      if (main.gateScores?.finished !== undefined && req) chips.push(`<span class="chip">finished ${pct(main.gateScores.finished)}</span>`)
    }
    const text = l.cut ? `${l.cut}—` : l.text
    items.push({ at: l.at, html: `<div class="item${main && main.route.action === "ignore" ? " dim" : ""}"><span class="who">${esc(l.speaker)}</span><span class="txt">${esc(text)}</span>${chips.length ? `<div class="chips">${chips.join("")}</div>` : ""}</div>` })
  }
  for (const t of s.tasks.values()) {
    if (t.dispatchedAt !== undefined) {
      items.push({ at: t.dispatchedAt + 1, html: `<div class="item agent"><span class="who">⚙ LLM agent · task ${t.task}</span><span class="txt">${t.job === "confirm" ? "verify" : "answer"}: ${esc(t.detail ?? "")}</span></div>` })
    }
    if (t.reportedAt !== undefined) {
      items.push({ at: t.reportedAt, html: `<div class="item agent"><span class="who">✓ task ${t.task} reported${t.ms ? ` in ${secs(t.ms)}` : ""}</span><span class="txt">${esc(t.result ?? "")}</span></div>` })
    }
  }
  for (const e of s.egg) {
    items.push({ at: e.at + 2, html: `<div class="item egg"><span class="kind">${KIND_LABEL[e.kind] ?? "Said"}</span><span class="who">Egg Head</span><span class="txt">${esc(e.text)}</span></div>` })
  }
  for (const q of s.quiet) {
    items.push({ at: q.at + 1, html: `<div class="item quiet"><span class="who">Stays quiet.</span>${esc(q.why)}</div>` })
  }
  if (!items.length) return
  items.sort((a, b) => a.at - b.at)
  const feed = $("feed")
  feed.innerHTML = items.map((i) => i.html).join("")
  if (Date.now() - feedTouched > 8000) feed.scrollTop = feed.scrollHeight // follow the call unless you scrolled

}

$("start").onclick = () => {
  audioOn = true
  $("start").disabled = true
  fetch("/start", { method: "POST" })
}
// joining mid-run: a click anywhere turns the sound on
document.addEventListener("click", () => (audioOn = true), { once: true })
connect(store)
setTimeout(() => (live = true), 400)
