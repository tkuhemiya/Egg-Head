// The decision tree on the dashboard: every way a line can go, drawn once, left to right. Pick a
// line and the path it took lights up, with Decider's scores against their thresholds at each
// step; a claim's path keeps growing over the next lines (second look, agent, gate) until it
// ends in Egg Head speaking or staying quiet. "Whole run" shows how many lines took each branch.
import { pop, flash, springs } from "./motion.js"
import { esc, secs } from "./store.js"

// Thresholds, as in src/Router.ts (T_CLAIM, T_ROUTE) and src/Conversation.ts (T_ADDRESSED, T_ASKS, T_FINISHED)
const T = { claim: 0.5, route: 0.25, addressed: 0.25, asks: 0.3, finished: 0.5 }
const REASONS = ["persisted", "not_repaired", "min_silence", "floor_open", "worth_it", "cooldown"]
const REASON_TEXT = {
  persisted: "the call moved on a turn", not_repaired: "nobody corrected it", min_silence: "nobody is talking",
  floor_open: "a natural gap", worth_it: "costly enough to raise", cooldown: "hasn't just spoken"
}

const n = (id, label, about, children = [], kind) => ({ id, label, about, children, kind })
const TREE = n("heard", "Line heard", "Decider asks three things at once", [
  n("claim", "States a fact?", `4 yes/no layers ≥ ${T.claim}`, [
    n("unrouted", "Couldn't route it", "no confident resource or check", [], "quiet"),
    n("check", "Fast check", `resource, check ≥ ${T.route}; live data`, [
      n("true", "Checks out", "live data agrees", [], "quiet"),
      n("unsure", "Inconclusive", "live data can't tell", [], "quiet"),
      n("wrong", "Wrong: wait a turn", "give the call a chance", [
        n("corrected", "Call corrected it", "no LLM call at all", [], "quiet"),
        n("barge", "Cut in", "someone is about to act on it", [], "speak"),
        n("agent", "Agent double-checks", "pi runs aws in the terminal", [
          n("overruled", "It was right", "the agent overruled the check", [], "quiet"),
          n("gate", "The gate", "six reasons, all must pass", [
            n("held", "Held back", "a reason failed", [], "quiet"),
            n("flag", "Raised it", "at the next gap", [], "speak")
          ])
        ])
      ])
    ])
  ]),
  n("addressed", "Talking to Egg Head?", `addressed ≥ ${T.addressed}`, [
    n("finished", "Finished talking?", `finished ≥ ${T.finished}, or 4 s quiet`, [
      n("answer", "Agent finds out", "ack, then the agent looks", [
        n("answered", "Answered", "at the next gap", [], "speak")
      ])
    ])
  ]),
  n("open", "Question to the call?", `asks ≥ ${T.asks}`, [
    n("dropped", "Someone answered", "Egg Head stays out", [], "quiet"),
    n("take", "Nobody did: agent", "2.5 s of silence, then it looks", [
      n("answered2", "Answered", "at the next gap", [], "speak")
    ])
  ]),
  n("nothing", "Just talk", "nothing to check or answer", [], "quiet")
])

const W = 164, H = 42, COL = 194, ROW = 48, PAD = 6

// layout: leaves take rows in order, a parent sits midway between its first and last child
const nodes = []
const edges = []
let rows = 0
;(function place(node, depth, parent) {
  node.depth = depth
  node.parent = parent
  nodes.push(node)
  if (parent) edges.push(node)
  if (!node.children.length) node.row = rows++
  node.children.forEach((c) => place(c, depth + 1, node))
  if (node.children.length) node.row = (node.children[0].row + node.children.at(-1).row) / 2
})(TREE, 0, null)
const byId = new Map(nodes.map((x) => [x.id, x]))
const depthMax = Math.max(...nodes.map((x) => x.depth))
const WIDTH = depthMax * COL + W + PAD * 2, HEIGHT = rows * ROW + PAD * 2
const pos = (x) => ({ x: PAD + x.depth * COL, y: PAD + x.row * ROW + (ROW - H) / 2 })

const bar = (p, t) => {
  const v = Number.isFinite(p) ? p : 0
  return `<span class="bar${v >= t ? " pass" : ""}"><i style="width:${(v * 100).toFixed(0)}%"></i><u style="left:${t * 100}%"></u></span>${v.toFixed(2)}`
}

/**
 * Where line `l` went: node id -> { state, meta }. States: yes (passed through), no (asked, and
 * the answer was no), run (happening now), wait (waiting here), skip (no agent in this run),
 * quiet / speak (the outcome).
 */
export function trace(s, l) {
  const path = new Map()
  const set = (id, state, meta = "") => path.set(id, { state, meta })
  const main = l.events.find((e) => e.speaker === l.speaker && e.route)
  if (!main) return path
  set("heard", "yes", `Decider ${Math.round(main.deciderMs)} ms`)
  const r = main.route, sc = r.scores ?? {}, gs = main.gateScores ?? {}
  const isClaim = r.action !== "ignore"
  const asked = l.events.find((e) => e.request && e.request.turn === main.turn)?.request
  const req = asked && (s.requests.get(asked.id) ?? asked) // where the question is now
  set("claim", isClaim ? "yes" : "no", bar(sc.claim, T.claim))
  set("addressed", req?.kind === "addressed" ? "yes" : "no", bar(gs.addressed, T.addressed))
  set("open", req?.kind === "open" ? "yes" : "no", bar(gs.asks, T.asks))
  if (!isClaim && !req) set("nothing", "quiet")

  if (isClaim) {
    const routeP = Math.min(sc.claim ?? 0, sc.resource ?? 0, sc.check ?? 0)
    if (r.action === "escalate") set("unrouted", "quiet", bar(routeP, T.route))
    else {
      set("check", "yes", `${esc(r.resource)} · ${esc(r.check)}`)
      const evidence = esc(main.checkEvidence ?? "")
      if (main.verdict === "supports") set("true", "quiet", evidence)
      else if (main.verdict !== "contradicts") set("unsure", "quiet", evidence)
      else {
        const c = s.claims.get(main.turn) ?? { state: "contradicted" }
        const task = c.task !== undefined ? s.tasks.get(c.task) : undefined
        set("wrong", c.state === "contradicted" ? "wait" : "yes", evidence)
        const agent = () => set("agent", task ? (task.state === "running" ? "run" : "yes") : "skip",
          task ? (task.ms ? `${secs(task.ms)} · ${esc(task.by?.split(" · ")[0] ?? "agent")}` : "running…") : "no agent this run")
        const gate = (state) => set("gate", state, c.gate ? `<span class="reasons">${REASONS.map((k) =>
          `<b class="${c.gate.reasons[k] ? "ok" : "bad"}" title="${k}: ${REASON_TEXT[k]}"></b>`).join("")}</span>` : "waiting for a gap")
        switch (c.state) {
          case "corrected": set("corrected", "quiet", c.repairedBy ? `by ${esc(c.repairedBy)}` : ""); break
          case "barged": set("barge", "speak", `act now ${bar(c.directive, 0.3)}`); break
          case "checking": agent(); break
          case "overruled": agent(); set("overruled", "quiet"); break
          case "confirmed": agent(); gate("wait"); break
          case "parked": agent(); gate("yes"); set("held", "quiet", "the call parked it"); break
          case "raised": agent(); gate("yes"); set("flag", "speak", esc(c.said ?? "")); break
        }
      }
    }
  }

  if (req) {
    const st = req.state
    const answer = esc(req.answer ?? "")
    if (req.kind === "addressed") {
      set("finished", st === "listening" ? "wait" : "yes", bar(gs.finished, T.finished))
      if (st === "checking") set("answer", "run", "running…")
      if (st === "ready") (set("answer", "yes"), set("answered", "wait", "waiting for a gap"))
      if (st === "answered") (set("answer", "yes"), set("answered", "speak", answer))
    } else {
      if (st === "listening") set("open", "wait", `${bar(gs.asks, T.asks)} anyone?`)
      if (st === "dropped") set("dropped", "quiet")
      if (st === "checking") set("take", "run", "running…")
      if (st === "ready") (set("take", "yes"), set("answered2", "wait", "waiting for a gap"))
      if (st === "answered") (set("take", "yes"), set("answered2", "speak", answer))
    }
  }
  return path
}

const reached = (p) => p && p.state !== "no"

/** Draws the tree into `box`; `update(s, index | null, focus)` shows one line's path, or counts for the run. */
export function createTree(box, { onNode } = {}) {
  box.style.width = `${WIDTH}px`
  box.style.height = `${HEIGHT}px`
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  svg.setAttribute("width", WIDTH)
  svg.setAttribute("height", HEIGHT)
  box.append(svg)
  const edgeEl = new Map()
  for (const c of edges) {
    const a = pos(c.parent), b = pos(c)
    const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, mx = (x1 + x2) / 2
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path")
    p.setAttribute("d", `M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`)
    p.setAttribute("pathLength", "1")
    svg.append(p)
    edgeEl.set(c.id, p)
  }
  const nodeEl = new Map()
  for (const x of nodes) {
    const el = document.createElement("div")
    const { x: left, y: top } = pos(x)
    el.className = `tn${x.kind ? ` leaf ${x.kind}-leaf` : ""}`
    el.style.cssText = `left:${left}px;top:${top}px;width:${W}px;height:${H}px`
    el.innerHTML = `<div class="tl"><span>${esc(x.label)}</span><b class="count"></b></div><div class="tm"></div>`
    el.onclick = () => onNode?.(x.id)
    box.append(el)
    nodeEl.set(x.id, el)
  }

  let last = new Map(), lastKey = ""
  function update(s, index, focus) {
    const lines = s.lines.filter((l) => l?.speaker)
    const line = index === null ? null : s.lines[index]
    const path = line ? trace(s, line) : null
    // whole run: how many lines reached each node
    const counts = new Map()
    if (!path) for (const l of lines) for (const [id, p] of trace(s, l)) if (reached(p)) counts.set(id, (counts.get(id) ?? 0) + 1)
    const most = Math.max(1, ...counts.values())
    const key = `${index}|${focus}|${JSON.stringify(path ? [...path] : [...counts])}`
    if (key === lastKey) return
    const fresh = lastKey.split("|")[0] !== String(index)
    lastKey = key

    for (const x of nodes) {
      const el = nodeEl.get(x.id)
      const p = path?.get(x.id)
      const state = path ? (p ? p.state : "off") : counts.has(x.id) ? "hit" : "off"
      const cls = `tn${x.kind ? ` leaf ${x.kind}-leaf` : ""} ${state}${state === "run" ? " running" : ""}${focus === x.id ? " focus" : ""}`
      const was = last.get(x.id)
      if (el.className !== cls) el.className = cls
      const meta = path ? (p?.meta || (p ? "" : x.about)) : x.about
      const tm = el.querySelector(".tm")
      if (tm._m !== meta) (tm.innerHTML = meta, tm._m = meta, tm.title = tm.textContent)
      el.querySelector(".count").textContent = path ? "" : counts.get(x.id) ?? ""
      // a node joins the path: it pops in order of depth; an outcome also flashes
      if (path && reached(p) && (fresh || !reached(was))) {
        const delay = (fresh ? x.depth : 0) * 70
        setTimeout(() => {
          pop(el, 0.9)
          if (p.state === "speak") flash(el, "rgba(255,255,255,.6)")
          if (!fresh && p.state === "quiet") flash(el, "rgba(34,197,94,.5)")
        }, delay)
      }
    }
    for (const c of edges) {
      const e = edgeEl.get(c.id)
      const p = path?.get(c.id)
      const on = path ? reached(p) : counts.has(c.id)
      e.setAttribute("class", path ? (on ? `on ${p.state}` : p ? "asked" : "") : on ? "hit" : "")
      e.style.strokeWidth = path ? "" : on ? `${1.5 + 5 * (counts.get(c.id) / most)}px` : ""
      const was = reached(last.get(c.id))
      if (path && on && (fresh || !was) && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        e.animate([{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], {
          duration: springs.snappy.duration, easing: springs.snappy.easing, delay: (fresh ? c.parent.depth : 0) * 70 + 30, fill: "backwards"
        })
      }
    }
    last = path ?? new Map()
  }

  /** The lines that reached a node, for highlighting the transcript. */
  const linesThrough = (s, id) => new Set(s.lines.filter((l) => l?.speaker && reached(trace(s, l).get(id))).map((l) => l.index))
  return { update, linesThrough, has: (id) => byId.has(id) }
}
