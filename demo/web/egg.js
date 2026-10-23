// Egg Head: soft cream egg, dot eyes set low and wide, pink blush, tiny morphing mouth.
// States: neutral | listening | speaking | unsure.
import { animate, createMouth, el, nextId } from "./core.js"

const EGG = "M100 22 C140 22 166 86 166 128 C166 170 138 194 100 194 C62 194 34 170 34 128 C34 86 60 22 100 22 Z"
const INK = "#5a4a44"

export function drawEggHead({ state = "neutral" } = {}) {
  const svg = el("svg", { viewBox: "0 0 200 210", class: "toon egg soft", preserveAspectRatio: "xMidYMax meet", "aria-label": "Egg Head" })
  const id = nextId("egg")
  const defs = el("defs", {}, svg)
  const clip = el("clipPath", { id: `${id}c` }, defs)
  el("path", { d: EGG }, clip)

  el("ellipse", { cx: 100, cy: 200, rx: 46, ry: 5, fill: "#e9dccb", opacity: 0.6 }, svg) // ground shadow
  const root = el("g", {}, svg)
  root.style.transformOrigin = "100px 194px"
  const tilt = el("g", {}, root)
  tilt.style.transformOrigin = "100px 194px"
  tilt.style.transition = "transform .45s cubic-bezier(.3,1.4,.5,1)"

  el("path", { d: EGG, fill: "#f7eee0" }, tilt)
  const shade = el("g", { "clip-path": `url(#${id}c)` }, tilt)
  el("ellipse", { cx: 112, cy: 226, rx: 100, ry: 52, fill: "#f0e2cf", opacity: 0.8 }, shade) // soft bottom shade
  el("ellipse", { cx: 78, cy: 70, rx: 12, ry: 20, fill: "#fffaf2", opacity: 0.45, transform: "rotate(-20 78 70)" }, shade)

  // cracked top (listening)
  const crack = el("g", { opacity: 0 }, tilt)
  crack.style.transition = "opacity .3s"
  el("path", { d: "M48 76 L60 70 L68 80 L80 68 L90 80 L102 66 L112 78 L124 66 L134 78 L146 70 L152 76", fill: "none", stroke: "#cdb89a", "stroke-width": 2.2, "stroke-linejoin": "round", "stroke-linecap": "round" }, crack)
  el("path", { d: "M118 30 C132 34 144 48 150 62 L138 58 L132 46 Z", fill: "#e8d6bc" }, crack)

  // face
  const face = el("g", {}, tilt)
  face.style.transition = "transform .4s ease"
  for (const x of [70, 130]) el("ellipse", { cx: x, cy: 142, rx: 9.5, ry: 5.5, fill: "#f4aaa4", opacity: 0.75 }, face)
  const eyes = []
  const pupils = []
  for (const x of [80, 120]) {
    const e = el("g", {}, face)
    e.style.transformOrigin = `${x}px 130px`
    pupils.push(el("circle", { cx: x, cy: 130, r: 5.6, fill: INK }, e))
    el("circle", { cx: x + 1.8, cy: 128, r: 1.5, fill: "#fff", opacity: 0.85 }, e)
    eyes.push(e)
  }
  const setMouth = createMouth(face, 100, 144, { ink: INK })

  // sound arcs (speaking) and "?" (unsure)
  const arcs = el("g", { fill: "none", stroke: "#f0b3a8", "stroke-width": 3, "stroke-linecap": "round", opacity: 0 }, root)
  for (const [d, o] of [["M24 112 Q16 128 24 144", 1], ["M14 104 Q3 128 14 152", 0.6], ["M176 112 Q184 128 176 144", 1], ["M186 104 Q197 128 186 152", 0.6]])
    el("path", { d, opacity: o }, arcs)
  const q = el("text", { x: 160, y: 46, "font-size": 34, "font-family": "ui-rounded, 'Nunito', system-ui, sans-serif", "font-weight": 700, fill: "#f0ad9e", opacity: 0 }, root)
  q.textContent = "?"
  q.style.transition = "opacity .3s"

  let cur = "neutral"
  const api = animate(svg, {
    root, eyes, setMouth,
    onFrame(t, level) {
      const talking = cur === "speaking" || level > 0.02
      arcs.setAttribute("opacity", talking ? (0.35 + level * 0.65).toFixed(2) : "0")
      arcs.style.transform = `scale(${1 + level * 0.06})`
      arcs.style.transformOrigin = "100px 128px"
      q.setAttribute("y", (46 + Math.sin(t * 2.4) * 2.5).toFixed(1))
    }
  })

  const setState = (s) => {
    cur = s
    crack.setAttribute("opacity", s === "listening" ? 1 : 0)
    q.setAttribute("opacity", s === "unsure" ? 1 : 0)
    tilt.style.transform = s === "unsure" ? "rotate(-7deg)" : "none"
    // listening: eyes glance up a touch. unsure: one eye slightly lower.
    face.style.transform = s === "listening" ? "translateY(-2px)" : "none"
    pupils[0].setAttribute("cy", s === "listening" ? 127 : s === "unsure" ? 133 : 130)
    pupils[1].setAttribute("cy", s === "listening" ? 127 : 130)
    svg.dataset.state = s
  }
  setState(state)
  const say = api.say
  return Object.assign(api, {
    setState,
    get state() { return cur },
    say(marks, durationS, opts) { if (cur !== "speaking") { api._prev = cur; setState("speaking") } say(marks, durationS, opts); clearTimeout(api._t); api._t = setTimeout(() => { if (cur === "speaking") setState(api._prev || "neutral") }, durationS * 1000 + 150) }
  })
}
