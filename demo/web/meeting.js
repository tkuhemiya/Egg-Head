// The meeting page: cartoon teammates who lip-sync to their Polly voices, Egg Head
// with what it is doing right now, a look-up pane (pi runs underneath), and a feed.
import { drawEggHead, drawPerson, drawRoom, personOf, roomOf } from "./avatars.js"
import { enter, flash, morph, pop, reconcile, roll, shake } from "./motion.js"
import { connect, createStore, eggState, esc } from "./store.js"

const $ = (id) => document.getElementById(id)
const h = (tag, cls, html) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}
const cfg = await fetch("/config").then((r) => r.json())

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
  const art = h("div", "art")
  const badge = h("div", "bubble")
  const label = h("div", "name", `${MIC_ON}<span>${esc(name)}</span>${p.role && !cls ? `<span class="role">${esc(p.role)}</span>` : ""}`)
  if (!cls.includes("egg")) {
    t.classList.add("has-room")
    const room = h("div", "room")
    room.append(drawRoom(roomOf(name, tiles.size).id))
    t.append(room, art, badge, label)
  } else t.append(art, badge, label)
  grid.insertBefore(t, $("captions"))
  return { t, art, badge, label }
}

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
const mind = h("div", "mind", '<div class="node state idle" id="egg-state"><i></i><span>Ready</span></div><div class="detail" id="egg-detail"></div>')
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
  box.innerHTML = `<b>${esc(name)}</b>`
  if (!words) box.insertAdjacentHTML("beforeend", esc(text))
  // each word arrives out of a blur as Polly says it
  else words.forEach((w) => captionTimers.push(setTimeout(() => box.insertAdjacentHTML("beforeend", `<span class="w">${esc(w.value)}</span> `), w.time)))
  captionTimers.push(setTimeout(() => box.classList.remove("on"), durationS * 1000 + 1400))
}
function cutCaption(name, text) {
  captionTimers.forEach(clearTimeout)
  captionTimers = []
  $("captions").className = "captions on"
  $("captions").innerHTML = `<b>${esc(name)}</b>${esc(text)}—`
  shake($("captions"), { intensity: 6, count: 5, rotate: 1 })
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
  const was = t.badge.classList.contains("on")
  t.badge.className = `bubble on ${cls}`
  t.badge.textContent = text
  if (cls === "cut") setTimeout(() => shake(t.badge, { intensity: 4, count: 4 }), 100)
  else if (!was) pop(t.badge)
  if (ms) setTimeout(() => t.badge.classList.remove("on"), ms)
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

const store = createStore()
let clockBase = null // { at: ms into the run (server), t: when it arrived here }
setInterval(() => {
  if (!clockBase) return
  const s = Math.floor((clockBase.at + Date.now() - clockBase.t) / 1000)
  roll($("timer"), `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`)
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
      const a = play(m.audio)
      playing.set(m.index, a)
      tiles.get(m.speaker)?.toon.say(m.marks, m.durationS, { audio: a, text: m.text })
      caption(m.speaker, m.marks, m.durationS, false, m.text)
      break
    }
    case "cut": {
      playing.get(m.index)?.pause()
      tiles.get(m.speaker)?.toon.stop()
      speaking(m.speaker, false)
      badge(m.speaker, "interrupted by Egg Head", "cut")
      shake(tiles.get(m.speaker)?.t ?? $("grid"), { intensity: 8, count: 6, rotate: 1.5 })
      if (tiles.get(m.speaker)) flash(tiles.get(m.speaker).t, "rgba(239,68,68,.6)")
      cutCaption(m.speaker, m.text)
      break
    }
    case "egghead":
      eggSpeakingUntil = Date.now() + m.durationS * 1000
      setTimeout(() => renderEgg(store.get()), m.durationS * 1000 + 50)
      speaking("Egg Head", true, m.durationS * 1000)
      flash(egg.t, "rgba(245,200,76,.5)")
      const ea = play(m.audio)
      eggToon.say(m.marks, m.durationS, { audio: ea, text: m.text })
      caption("Egg Head", m.marks, m.durationS, true, m.text)
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
  renderWork(s)
  renderFeed(s)
  if (!$("sheet").hidden) renderSheet()
})

let eggSpeakingUntil = 0
function renderEgg(s) {
  const st = Date.now() < eggSpeakingUntil ? { key: "floor", text: "Speaking" } : eggState(s)
  const node = $("egg-state")
  if (node.dataset.key !== st.key) {
    // checking is a running node: blue, a sweep of light and a nervous jitter
    node.className = `node state ${st.key}${st.key === "checking" ? " running jitter" : ""}`
    if (node.dataset.key && ["gap", "floor", "listening"].includes(st.key)) (pop(node), flash(node))
    node.dataset.key = st.key
  }
  morph(node.querySelector("span"), st.text)
  if (eggToon.state !== "speaking" && Date.now() >= eggSpeakingUntil) {
    let avatar = "neutral"
    if (st.key === "checking") avatar = "unsure"
    else {
      const addr = [...s.requests.values()].find((r) => r.state === "listening" && r.kind === "addressed")
      if (addr || st.key === "listening" || st.key === "waiting") avatar = "listening"
    }
    if (eggToon.state !== avatar) eggToon.setState(avatar)
  }
  const running = [...s.tasks.values()].find((t) => t.state === "running")
  const listening = [...s.requests.values()].find((r) => r.state === "listening" && r.kind === "addressed")
  const confirmed = [...s.claims.values()].find((c) => c.state === "confirmed")
  const ready = [...s.requests.values()].find((r) => r.state === "ready")
  const answering = [...s.requests.values()].find((r) => r.state === "checking")
  const detail = running
    ? running.job === "confirm" ? `Checking ${running.detail?.split(":")[0]}'s claim` : `Looking into ${answering?.speaker ?? "a"}'s question`
    : confirmed ? `${confirmed.speaker}'s claim is wrong`
    : ready ? `Has an answer for ${ready.speaker}`
    : s.status && (s.running || s.done) ? s.status
    : ""
  if ($("egg-detail").textContent !== detail) {
    $("egg-detail").textContent = detail
    if (detail) enter($("egg-detail"), { y: 6, scale: 1 })
  }
  const busy = !!running
  if (busy) {
    clearTimeout(renderEgg.shrink)
    renderEgg.shrink = 0
    document.body.classList.add("work-busy")
  } else if (document.body.classList.contains("work-busy") && !renderEgg.shrink) {
    renderEgg.shrink = setTimeout(() => {
      renderEgg.shrink = 0
      document.body.classList.remove("work-busy")
    }, 3000)
  }
  $("work-pill").classList.toggle("on", busy)
}

function renderWork(s) {
  const jobs = [...s.tasks.values()].filter((t) => t.dispatchedAt !== undefined)
  const box = $("work")
  if (!jobs.length) {
    if (!box.querySelector(".empty")) box.innerHTML = `<div class="empty">Waiting.</div>`
    return
  }
  box.querySelector(".empty")?.remove()
  reconcile(box, jobs.map((t) => {
    const who = t.job === "confirm" ? `${(t.detail ?? "").split(":")[0]}'s claim` : "a question"
    const st = t.state === "running" ? "looking" : t.state === "failed" ? "agent failed" : "found"
    const raw = (t.result ?? "").replace(/^confirmed: /, "")
    const useful = raw && !/no model|fast check/i.test(raw)
    const body = t.state === "running" ? `Looking up ${esc(who)}.`
      : t.state === "failed" ? `Could not look up ${esc(who)}; Egg Head fell back to the direct check.`
      : useful ? esc(raw) : `Looked up ${esc(who)}.`
    return { key: `w${t.task}`, cls: `job ${t.state === "running" ? "running" : t.state === "failed" ? "failed" : "done"}`, html: `<div class="k">${esc(st)}</div><p>${body}</p>` }
  }))
}

let feedTouched = 0
$("feed").addEventListener("wheel", () => (feedTouched = Date.now()), { passive: true })

/** One feed, oldest first: what was said, whether a claim held up, what the agent did, what Egg Head said. */
/** The line that started an agent task: the claim (or question) it quotes, at or before dispatch. */
function triggerOf(t, lines) {
  const said = t.detail ?? ""
  for (let i = Math.min(t.index ?? lines.length - 1, lines.length - 1); i >= 0; i--) {
    const l = lines[i]
    if (l?.speaker && l.text && said.includes(l.text.trim())) return i
  }
  return t.index
}

const AGENT_CHIP = { running: "agent looking", done: "agent", failed: "agent failed" }

function renderFeed(s) {
  const items = []
  const started = new Map() // line index -> tasks it started
  for (const t of s.tasks.values()) {
    if (t.dispatchedAt === undefined) continue
    const i = triggerOf(t, s.lines)
    started.set(i, [...(started.get(i) ?? []), t])
  }
  for (const l of s.lines) {
    if (!l?.speaker) continue
    const main = l.events.find((e) => e.speaker === l.speaker && e.route)
    const req = main && l.events.find((e) => e.request && e.request.turn === main.turn)?.request
    const tag = main?.verdict === "contradicts" ? '<span class="chip bad" data-k="bad">wrong</span>'
      : main?.verdict === "supports" ? '<span class="chip good" data-k="good">checks out</span>'
      : req?.kind === "addressed" ? '<span class="chip ask" data-k="ask">to Egg Head</span>'
      : ""
    const text = l.cut ? `${l.cut}—` : l.text
    const agent = (started.get(l.index) ?? []).map((t) =>
      `<button class="chip agent ${t.state}" data-task="${t.task}" title="Show what the agent did">${AGENT_CHIP[t.state] ?? "agent"} ›</button>`).join(" ")
    const chips = [tag, agent].filter(Boolean).join(" ")
    items.push({ at: l.at, key: `l${l.index}`, cls: "item", html: `<span class="who">${esc(l.speaker)}</span><span class="txt">${esc(text)}</span>${chips ? ` ${chips}` : ""}` })
  }
  for (const t of s.tasks.values()) {
    if (t.dispatchedAt === undefined || t.state !== "running") continue
    const what = t.job === "confirm" ? `Checking ${t.detail?.split(":")[0]}'s claim` : "Looking into the question"
    items.push({ at: t.dispatchedAt + 1, key: `t${t.task}`, cls: "item egg running", html: `<span class="who">Egg Head</span><span class="txt">${esc(what)}…</span>` })
  }
  s.egg.forEach((e, i) => items.push({ at: e.at + 2, key: `e${i}`, cls: "item egg", html: `<span class="who">Egg Head</span><span class="txt">${esc(e.text)}</span>` }))
  s.quiet.forEach((q, i) => items.push({ at: q.at + 1, key: `q${i}`, cls: "item quiet", html: `<span class="who">Stayed quiet</span> ${esc(q.why)}` }))
  if (!items.length) return
  items.sort((a, b) => a.at - b.at)
  const feed = $("feed")
  feed.querySelector(".empty")?.remove()
  reconcile(feed, items, {
    onEnter: (el, o) => (el.classList.contains("egg") ? (enter(el, o), setTimeout(() => (pop(el, 0.9), flash(el, "rgba(245,200,76,.5)")), 60)) : enter(el, o)),
    onChange: (el, added) => {
      // the agent reported: a white flash and a bouncy settle; a claim found wrong: a shake
      if (el.classList.contains("done") || el.classList.contains("failed")) (flash(el), pop(el, 0.94))
      if (el.classList.contains("failed")) shake(el)
      if (added.some((a) => a.classList.contains("bad"))) (shake(el, { intensity: 5, count: 5, rotate: 1 }), flash(el, "rgba(239,68,68,.55)"))
      if (added.some((a) => a.classList.contains("good"))) flash(el, "rgba(34,197,94,.45)")
    }
  })
  if (Date.now() - feedTouched > 8000) feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" }) // follow the call unless you scrolled
}

// ---------------------------------------------------------------------------
// The agent sheet: click an "agent" chip to see that task and the agent's terminal
// ---------------------------------------------------------------------------

let term
let sheetTask
function openTerminal() {
  if (term) return
  term = new window.Terminal({
    fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.1,
    cursorBlink: false,
    disableStdin: true,
    scrollback: 4000,
    theme: { background: "#0a0a0a", foreground: "#e5e5e5", cursor: "#3b82f6", selectionBackground: "#262626" }
  })
  term.fit = new window.FitAddon.FitAddon()
  term.loadAddon(term.fit)
  term.open($("sheet-term"))
  let replayed = false
  new EventSource("/pty").onmessage = (e) => term.write(JSON.parse(e.data).d, () => {
    // the first message is the whole scrollback: once it is on screen, go to the task asked for
    if (!replayed && sheetTask !== undefined) scrollToTask(sheetTask)
    replayed = true
  })
}

/** Scroll the terminal to where the task was typed in (pi echoes the prompt), else to the end. */
function scrollToTask(n) {
  const buf = term.buffer.active
  for (let y = buf.length - 1; y >= 0; y--) {
    if (buf.getLine(y)?.translateToString(true).includes(`Task ${n} ·`)) return term.scrollToLine(Math.max(0, y - 1))
  }
  term.scrollToBottom()
}

function renderSheet() {
  const t = sheetTask !== undefined && store.get().tasks.get(sheetTask)
  if (!t) return
  const what = t.job === "confirm" ? `Checking ${(t.detail ?? "").split(":")[0]}'s claim` : "Answering a question"
  const state = t.state === "running" ? "looking" : t.state === "failed" ? "agent failed" : "found"
  const took = t.ms !== undefined && t.by && t.by !== "direct" ? ` · ${(t.ms / 1000).toFixed(1)} s` : ""
  $("sheet-head").innerHTML = `<b>${esc(what)}</b><span class="chip agent ${t.state}">${esc(state)}${took}</span>`
  $("sheet-asked").textContent = t.detail ?? ""
  $("sheet-found").textContent = t.state === "running" ? "Still looking…"
    : t.state === "failed" ? `${t.result ?? "No report."} Egg Head fell back to the direct check.`
    : `${t.result ?? ""}${t.by ? ` (${t.by})` : ""}`
}

function openSheet(task) {
  sheetTask = task
  renderSheet()
  $("sheet").hidden = false
  enter($("sheet").querySelector(".sheet-card"), { y: 14, scale: 0.98 })
  const fresh = !term
  openTerminal()
  requestAnimationFrame(() => {
    try { term.fit.fit() } catch {}
    if (!fresh) scrollToTask(task)
  })
}
const closeSheet = () => { $("sheet").hidden = true; sheetTask = undefined }

$("feed").addEventListener("click", (e) => {
  const chip = e.target.closest?.(".chip.agent[data-task]")
  if (chip) openSheet(Number(chip.dataset.task))
})
$("sheet").addEventListener("click", (e) => { if (e.target === $("sheet") || e.target.closest(".sheet-close")) closeSheet() })
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet() })

$("start").onclick = () => {
  audioOn = true
  pop($("start"), 0.9)
  $("start").disabled = true
  fetch("/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
}
// joining mid-run: a click anywhere turns the sound on
document.addEventListener("click", () => (audioOn = true), { once: true })
connect(store)
setTimeout(() => (live = true), 400)
