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

const n = (id, label, about, children = [], extra = {}) =>
  ({ id, label, about, children, ...(typeof extra === "string" ? { kind: extra } : extra) })
const TREE = n("heard", "Line heard", "one Decider batch on the latest line", [
  n("claim", "States a fact?", `4 yes/no layers ≥ ${T.claim}`, [
    n("unrouted", "Couldn't route it", "no confident resource or check", [], {
      kind: "quiet", type: "outcome",
      ask: "Can we name one resource and one check for this claim?",
      choices: ["yes → fast check", "no → stay quiet (or escalate)"]
    }),
    n("check", "Fast check", `resource, check ≥ ${T.route}; live data`, [
      n("true", "Checks out", "live data agrees", [], {
        kind: "quiet", type: "outcome",
        ask: "Does live data agree with what they said?",
        choices: ["agrees → stay quiet", "can't tell → stay quiet", "contradicts → wait a turn"]
      }),
      n("unsure", "Inconclusive", "live data can't tell", [], {
        kind: "quiet", type: "outcome",
        ask: "Does live data agree with what they said?",
        choices: ["agrees", "can't tell", "contradicts"]
      }),
      n("wrong", "Wrong: wait a turn", "give the call a chance", [
        n("corrected", "Call corrected it", "no model call at all", [], {
          kind: "quiet", type: "outcome",
          ask: "Did someone on the call correct the claim before Egg Head spoke?",
          choices: ["yes → stay quiet", "no → look it up"]
        }),
        n("barge", "Cut in", "someone is about to act on it", [], {
          kind: "speak", type: "outcome",
          ask: "Are they telling someone to act on a resource that is already known wrong?",
          choices: ["act now → cut in", "just mentioning it → wait"]
        }),
        n("agent", "Looks it up", "Egg Head checks live data, then the gate", [
          n("overruled", "It was right", "the look-up overruled the fast check", [], {
            kind: "quiet", type: "outcome",
            ask: "Did the second look agree with the speaker?",
            choices: ["speaker was right → stay quiet", "still wrong → the gate"]
          }),
          n("gate", "The gate", "six reasons, all must pass", [
            n("held", "Held back", "a reason failed", [], {
              kind: "quiet", type: "outcome",
              ask: "Do all six reasons to speak pass?",
              choices: REASONS.map((k) => `${k}: ${REASON_TEXT[k]}`)
            }),
            n("flag", "Raised it", "at the next gap", [], {
              kind: "speak", type: "outcome",
              ask: "Do all six reasons to speak pass?",
              choices: ["yes → speak at a gap", "no → stay quiet"]
            })
          ], { type: "gate", ask: "Six independent reasons. All must pass before Egg Head speaks.", choices: REASONS.map((k) => `${k}: ${REASON_TEXT[k]}`) })
        ], { type: "work", ask: "Look the resource up (coding agent underneath, or the fast check).", choices: ["found → the gate", "speaker was right → stay quiet"] })
      ], { type: "wait", ask: "Give the call one turn to correct itself before looking it up.", choices: ["someone corrects it", "someone is about to act → cut in", "nobody does → look it up"] })
    ], { type: "lookup", ask: "Name the resource, pick a check, compare live data.", threshold: T.route, choices: ["agrees", "can't tell", "contradicts"] }),
    n("addressed", "Talking to Egg Head?", `no on the claim; addressed ≥ ${T.addressed}`, [
      n("finished", "Finished talking?", `finished ≥ ${T.finished}, or 4 s quiet`, [
        n("answer", "Looks it up", "ack, then Egg Head looks", [
          n("answered", "Answered", "at the next gap", [], { kind: "speak", type: "outcome", ask: "Speak the answer at the next gap.", choices: ["ack now", "answer when there is a gap"] })
        ], { type: "work", ask: "Find the answer from live data.", choices: ["ack", "then speak at a gap"] })
      ], { type: "yes/no", ask: "Has this speaker finished? Trailing 'uh…' waits; 4 s of quiet also counts as done.", threshold: T.finished, choices: ["not yet → wait", "yes → look it up"] }),
      n("open", "Question to the call?", `no on claim and addressed; asks ≥ ${T.asks}`, [
        n("dropped", "Someone answered", "Egg Head stays out", [], { kind: "quiet", type: "outcome", ask: "Did someone else take the question?", choices: ["yes → stay quiet", "nobody for 2.5 s → take it"] }),
        n("take", "Nobody did: take it", "2.5 s of silence, then Egg Head looks", [
          n("answered2", "Answered", "at the next gap", [], { kind: "speak", type: "outcome", ask: "Speak the answer at the next gap.", choices: ["take it", "then answer"] })
        ], { type: "work", ask: "The call left a question hanging. Egg Head takes it.", choices: ["look it up", "answer at a gap"] }),
        n("nothing", "Just talk", "no on all three", [], {
          kind: "quiet", type: "outcome", fork: "no",
          ask: "Not a claim, not aimed at Egg Head, not a hanging question. Stay quiet.",
          choices: ["stay quiet"]
        })
      ], {
        type: "yes/no", fork: "no",
        ask: "Is this a question to the people on the call (not to Egg Head)? Asked only after the line was not a claim and not aimed at Egg Head.",
        threshold: T.asks,
        choices: ["yes → give them 2.5 s", "no → just talk"]
      })
    ], {
      type: "yes/no", fork: "no",
      ask: "Is the latest utterance aimed at Egg Head? Asked only after the line was not a claim.",
      threshold: T.addressed,
      choices: ["yes → wait until they finish", "no → is it a question to the call?"]
    })
  ], {
    type: "yes/no",
    ask: "Does the latest speaker state a fact about the current state of a system?",
    threshold: T.claim,
    choices: ["yes → name a resource and check", "no → talking to Egg Head?"],
    layers: [
      "fact about a system or service?",
      "how something is right now, not a guess?",
      "a status, number or observation?",
      "unsure / guessing / planning? (this one counts against)"
    ]
  })
], { type: "batch", ask: "One Decider batch answers all three, but the tree reads them in order: claim, then addressed, then a hanging question. No on all three is just talk.", choices: ["yes, a claim", "no → talking to Egg Head?", "no → question to the call?", "no → just talk"] })

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
          task ? (task.ms ? `${secs(task.ms)}` : "looking…") : "fast check")
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

  if (isClaim) return path

  set("addressed", req?.kind === "addressed" ? "yes" : "no", bar(gs.addressed, T.addressed))
  if (req?.kind === "addressed") {
    const st = req.state
    const answer = esc(req.answer ?? "")
    set("finished", st === "listening" ? "wait" : "yes", bar(gs.finished, T.finished))
    if (st === "checking") set("answer", "run", "running…")
    if (st === "ready") (set("answer", "yes"), set("answered", "wait", "waiting for a gap"))
    if (st === "answered") (set("answer", "yes"), set("answered", "speak", answer))
    return path
  }

  set("open", req?.kind === "open" ? "yes" : "no", bar(gs.asks, T.asks))
  if (req?.kind === "open") {
    const st = req.state
    const answer = esc(req.answer ?? "")
    if (st === "listening") set("open", "wait", `${bar(gs.asks, T.asks)} anyone?`)
    if (st === "dropped") set("dropped", "quiet")
    if (st === "checking") set("take", "run", "running…")
    if (st === "ready") (set("take", "yes"), set("answered2", "wait", "waiting for a gap"))
    if (st === "answered") (set("take", "yes"), set("answered2", "speak", answer))
    return path
  }

  set("nothing", "quiet")
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
    if (c.fork === "no") {
      const t = document.createElementNS("http://www.w3.org/2000/svg", "text")
      t.setAttribute("x", String(mx))
      t.setAttribute("y", String((y1 + y2) / 2 - 5))
      t.setAttribute("class", "fork-no")
      t.textContent = "no"
      svg.append(t)
    }
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
      e.setAttribute("class", path ? (on ? `on ${p.state}` : p?.state === "no" ? "no" : p ? "asked" : "") : on ? "hit" : "")
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
  return { update, linesThrough, has: (id) => byId.has(id), inspect: (id) => inspectNode(id) }
}

const TYPE_LABEL = { batch: "Batch", "yes/no": "Yes / no", lookup: "Lookup", wait: "Wait", work: "Look-up", gate: "Gate", outcome: "Outcome" }

/** Static copy for a tree node, for the inspector. */
export function inspectNode(id) {
  const x = byId.get(id)
  if (!x) return null
  return {
    id: x.id,
    label: x.label,
    about: x.about,
    type: x.type ?? (x.kind === "speak" || x.kind === "quiet" ? "outcome" : "step"),
    typeLabel: TYPE_LABEL[x.type] ?? "Step",
    parent: x.parent?.id ?? null,
    ask: x.ask ?? x.about,
    threshold: x.threshold,
    choices: x.choices ?? x.children.map((c) => c.label),
    layers: x.layers ?? [],
    kind: x.kind
  }
}
