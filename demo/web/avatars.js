// Cartoon teammates: flat cut-out characters (thick outlines, round heads, dot eyes) drawn as
// SVG, with mouths driven by Polly's viseme marks so they lip-sync to the voice clip.

const NS = "http://www.w3.org/2000/svg"
const INK = "#1b1820"

export const PEOPLE = {
  Priya: { skin: "#b27a52", hair: "#1e1513", style: "long", shirt: "#c63f4f", collar: "#8f2534", headset: true, brows: true, bg: ["#3b4a63", "#232c3d"], role: "Incident commander" },
  Jordan: { skin: "#f2c7a1", hair: "#6c4024", style: "beanie", hat: "#2f8a63", hatBand: "#1f5e43", shirt: "#3a70bb", collar: "#25508c", bg: ["#4a3e5c", "#2a2236"], role: "Backend" },
  Sam: { skin: "#f5d2b3", hair: "#7c7c84", style: "bald", beard: "#8a6440", glasses: "#2b2b33", shirt: "#59636f", collar: "#3e464f", bg: ["#3d5552", "#22312f"], role: "Database" },
  Lee: { skin: "#dcab7c", hair: "#16131a", style: "bob", glasses: "#7a2d8f", shirt: "#7d50a8", collar: "#5a3480", brows: true, bg: ["#5a4a3a", "#33291f"], role: "Release" },
  Mei: { skin: "#f7d6b8", hair: "#2b1e1b", style: "bun", shirt: "#e8902f", collar: "#b86a19", headset: true, brows: true, bg: ["#44506a", "#272f40"], role: "SRE" }
}

const FALLBACK_SHIRTS = ["#3a8fb7", "#b7503a", "#5aa05a", "#9a5ab7"]
export const personOf = (name, i = 0) =>
  PEOPLE[name] ?? { skin: "#e8b98f", hair: "#3b2a20", style: "short", shirt: FALLBACK_SHIRTS[i % 4], collar: "#333", bg: ["#3a3f4a", "#22252c"], role: "" }

const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  if (parent) parent.append(e)
  return e
}
const outline = { stroke: INK, "stroke-width": 3.2, "stroke-linejoin": "round", "stroke-linecap": "round" }

// Mouth shapes by Polly viseme (https://docs.aws.amazon.com/polly/latest/dg/ph-table-english-us.html)
const SHAPES = {
  rest: null,
  closed: null,
  small: { rx: 6.5, ry: 3.6 },
  wide: { rx: 11, ry: 5 },
  open: { rx: 9, ry: 9.5 },
  round: { rx: 5.8, ry: 7.5 },
  teeth: { rx: 9, ry: 3.4 }
}
const VISEME_SHAPE = {
  sil: "rest", p: "closed", t: "small", S: "small", T: "small", s: "small", k: "small", r: "round",
  i: "wide", e: "wide", E: "wide", a: "open", "@": "open", o: "round", O: "round", u: "round", f: "teeth"
}

function mouth(parent, cx, cy, scale = 1) {
  const g = el("g", { class: "mouth", transform: `translate(${cx} ${cy}) scale(${scale})` }, parent)
  const smile = el("path", { d: "M-11 -1 Q0 6 11 -1", fill: "none", ...outline }, g)
  const hole = el("ellipse", { cx: 0, cy: 0, rx: 8, ry: 6, fill: "#3b1218", ...outline, "stroke-width": 2.6 }, g)
  const tongue = el("ellipse", { cx: 0, cy: 4, rx: 5, ry: 3, fill: "#e0606f" }, g)
  const teeth = el("rect", { x: -7, y: -3.6, width: 14, height: 3.2, rx: 1, fill: "#fff" }, g)
  const set = (name) => {
    const s = SHAPES[name]
    smile.style.display = s ? "none" : ""
    for (const part of [hole, tongue]) part.style.display = s ? "" : "none"
    teeth.style.display = name === "teeth" || name === "wide" ? "" : "none"
    if (!s) {
      smile.setAttribute("d", name === "closed" ? "M-9 0 Q0 2 9 0" : "M-11 -1 Q0 6 11 -1")
      return
    }
    hole.setAttribute("rx", s.rx)
    hole.setAttribute("ry", s.ry)
    tongue.setAttribute("rx", Math.max(2, s.rx * 0.55))
    tongue.setAttribute("ry", Math.max(1.2, s.ry * 0.35))
    tongue.setAttribute("cy", s.ry * 0.5)
    teeth.setAttribute("y", -s.ry + 0.4)
    teeth.setAttribute("width", s.rx * 1.5)
    teeth.setAttribute("x", -s.rx * 0.75)
  }
  set("rest")
  return set
}

function eyes(parent, y, lookX = 0) {
  const g = el("g", { class: "eyes" }, parent)
  for (const [cx, inner] of [[83, 1], [117, -1]]) {
    const eye = el("g", { class: "eye" }, g)
    el("ellipse", { cx, cy: y, rx: 16.5, ry: 19.5, fill: "#fff", ...outline, "stroke-width": 2.6 }, eye)
    el("circle", { cx: cx + inner * 4.5 + lookX, cy: y + 2, r: 3.4, fill: INK, class: "pupil" }, eye)
  }
  return g
}

function hairBack(g, p) {
  if (p.style === "long") el("path", { d: "M38 92 C30 150 42 176 60 182 L140 182 C158 176 170 150 162 92 C160 60 136 36 100 36 C64 36 40 60 38 92 Z", fill: p.hair, ...outline }, g)
  if (p.style === "bob") el("path", { d: "M36 96 C34 128 40 142 52 146 L148 146 C160 142 166 128 164 96 C162 58 136 34 100 34 C64 34 38 58 36 96 Z", fill: p.hair, ...outline }, g)
  if (p.style === "bun") el("circle", { cx: 100, cy: 30, r: 17, fill: p.hair, ...outline }, g)
}

function hairFront(g, p) {
  if (p.style === "long" || p.style === "bob") {
    el("path", { d: "M38 90 C40 52 66 34 100 34 C134 34 160 52 162 90 C146 72 124 62 104 62 C92 74 70 82 38 90 Z", fill: p.hair, ...outline }, g)
  } else if (p.style === "bun") {
    el("path", { d: "M37 86 C40 50 66 36 100 36 C134 36 160 50 163 86 C150 66 128 56 100 56 C72 56 50 66 37 86 Z", fill: p.hair, ...outline }, g)
  } else if (p.style === "beanie") {
    el("path", { d: "M34 84 C34 44 62 22 100 22 C138 22 166 44 166 84 Z", fill: p.hat, ...outline }, g)
    el("rect", { x: 30, y: 74, width: 140, height: 18, rx: 8, fill: p.hatBand, ...outline }, g)
    el("circle", { cx: 100, cy: 18, r: 10, fill: p.hatBand, ...outline }, g)
    el("path", { d: "M40 96 C38 102 39 108 42 112 M160 96 C162 102 161 108 158 112", fill: "none", stroke: p.hair, "stroke-width": 6, "stroke-linecap": "round" }, g)
  } else if (p.style === "bald") {
    el("path", { d: "M38 98 C36 86 40 78 46 74 M162 98 C164 86 160 78 154 74", fill: "none", stroke: p.hair, "stroke-width": 7, "stroke-linecap": "round" }, g)
    el("path", { d: "M78 44 Q84 40 90 44", fill: "none", stroke: "#fff", "stroke-width": 3, opacity: 0.35, "stroke-linecap": "round" }, g)
  } else {
    el("path", { d: "M40 84 C42 48 68 34 100 34 C132 34 158 48 160 84 C140 66 120 60 100 64 C80 60 60 66 40 84 Z", fill: p.hair, ...outline }, g)
  }
}

/** A teammate's cartoon. Returns { svg, setMouth, talking(on) }. */
export function drawPerson(name, i = 0) {
  const p = personOf(name, i)
  const svg = el("svg", { viewBox: "0 0 200 200", class: "toon", preserveAspectRatio: "xMidYMax meet", "aria-label": name })
  const figure = el("g", { class: "figure" }, svg)
  el("path", { d: "M30 204 C30 166 56 148 100 148 C144 148 170 166 170 204 Z", fill: p.shirt, ...outline }, figure)
  el("path", { d: "M82 150 L100 170 L118 150", fill: "none", stroke: p.collar, "stroke-width": 5, "stroke-linejoin": "round" }, figure)
  const head = el("g", { class: "head" }, figure)
  hairBack(head, p)
  el("ellipse", { cx: 100, cy: 98, rx: 64, ry: 56, fill: p.skin, ...outline }, head)
  if (p.beard) el("path", { d: "M44 108 C50 150 76 158 100 158 C124 158 150 150 156 108 C142 128 124 134 100 134 C76 134 58 128 44 108 Z", fill: p.beard, ...outline }, head)
  hairFront(head, p)
  eyes(head, 92)
  if (p.brows) {
    el("path", { d: "M70 66 Q82 60 94 66", fill: "none", stroke: p.hair, "stroke-width": 4, "stroke-linecap": "round" }, head)
    el("path", { d: "M106 66 Q118 60 130 66", fill: "none", stroke: p.hair, "stroke-width": 4, "stroke-linecap": "round" }, head)
  }
  if (p.glasses) {
    el("circle", { cx: 83, cy: 92, r: 21, fill: "none", stroke: p.glasses, "stroke-width": 3.5 }, head)
    el("circle", { cx: 117, cy: 92, r: 21, fill: "none", stroke: p.glasses, "stroke-width": 3.5 }, head)
  }
  const setMouth = mouth(head, 100, 128)
  if (p.headset) {
    el("path", { d: "M34 98 C30 40 170 40 166 98", fill: "none", stroke: "#2a2a30", "stroke-width": 5 }, head)
    el("rect", { x: 26, y: 88, width: 14, height: 24, rx: 6, fill: "#2a2a30" }, head)
    el("path", { d: "M34 110 Q50 140 80 134", fill: "none", stroke: "#2a2a30", "stroke-width": 3.5, "stroke-linecap": "round" }, head)
    el("circle", { cx: 82, cy: 134, r: 4, fill: "#2a2a30" }, head)
  }
  return animated(svg, setMouth)
}

/** Egg Head: an egg with big round glasses and a bow tie. */
export function drawEggHead() {
  const svg = el("svg", { viewBox: "0 0 200 200", class: "toon egg", preserveAspectRatio: "xMidYMax meet", "aria-label": "Egg Head" })
  const defs = el("defs", {}, svg)
  const grad = el("radialGradient", { id: "eggshade", cx: "40%", cy: "30%", r: "75%" }, defs)
  el("stop", { offset: "0%", "stop-color": "#fffdf6" }, grad)
  el("stop", { offset: "70%", "stop-color": "#f6ead0" }, grad)
  el("stop", { offset: "100%", "stop-color": "#e6d3ad" }, grad)
  const figure = el("g", { class: "figure" }, svg)
  const head = el("g", { class: "head" }, figure)
  el("path", { d: "M100 16 C142 16 170 80 170 122 C170 168 140 194 100 194 C60 194 30 168 30 122 C30 80 58 16 100 16 Z", fill: "url(#eggshade)", ...outline }, head)
  el("circle", { cx: 72, cy: 48, r: 3, fill: "#d9c39a" }, head)
  el("circle", { cx: 82, cy: 40, r: 2.2, fill: "#d9c39a" }, head)
  el("circle", { cx: 124, cy: 44, r: 2.6, fill: "#d9c39a" }, head)
  eyes(head, 104)
  el("circle", { cx: 83, cy: 104, r: 23, fill: "rgba(170,210,255,.12)", stroke: INK, "stroke-width": 5 }, head)
  el("circle", { cx: 117, cy: 104, r: 23, fill: "rgba(170,210,255,.12)", stroke: INK, "stroke-width": 5 }, head)
  el("path", { d: "M106 102 Q100 96 94 102", fill: "none", stroke: INK, "stroke-width": 4 }, head)
  el("path", { d: "M68 92 Q74 86 80 90", fill: "none", stroke: "#fff", "stroke-width": 3, "stroke-linecap": "round", opacity: 0.8, class: "glint" }, head)
  el("path", { d: "M68 74 Q82 66 96 74", fill: "none", stroke: INK, "stroke-width": 4, "stroke-linecap": "round", class: "brow" }, head)
  el("path", { d: "M104 74 Q118 66 132 74", fill: "none", stroke: INK, "stroke-width": 4, "stroke-linecap": "round", class: "brow" }, head)
  const setMouth = mouth(head, 100, 150, 1.05)
  el("path", { d: "M100 182 L80 172 L80 194 Z M100 182 L120 172 L120 194 Z", fill: "#e2a72e", ...outline, "stroke-width": 2.6 }, figure)
  el("circle", { cx: 100, cy: 183, r: 4.5, fill: "#b9801a", ...outline, "stroke-width": 2.2 }, figure)
  return animated(svg, setMouth)
}

function animated(svg, setMouth) {
  let raf = 0
  let blinkTimer = 0
  const blink = () => {
    svg.classList.add("blink")
    setTimeout(() => svg.classList.remove("blink"), 140)
    blinkTimer = setTimeout(blink, 2200 + Math.random() * 3800)
  }
  blinkTimer = setTimeout(blink, 800 + Math.random() * 3000)

  const stop = () => {
    cancelAnimationFrame(raf)
    raf = 0
    svg.classList.remove("talking")
    setMouth("rest")
  }

  /** Lip-sync to Polly visemes (ms from the clip start) for durationS seconds. */
  const say = (marks, durationS) => {
    stop()
    const visemes = marks?.visemes?.length ? marks.visemes : null
    const start = performance.now()
    svg.classList.add("talking")
    let k = 0
    let last = ""
    const frame = () => {
      const t = performance.now() - start
      if (t > durationS * 1000) return stop()
      let shape
      if (visemes) {
        while (k + 1 < visemes.length && visemes[k + 1].time <= t) k++
        shape = VISEME_SHAPE[visemes[k].time <= t ? visemes[k].value : "sil"] ?? "small"
      } else {
        shape = ["open", "small", "wide", "round", "closed"][Math.floor(t / 110) % 5]
      }
      if (shape !== last) setMouth((last = shape))
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
  }

  return { svg, say, stop, dispose: () => (stop(), clearTimeout(blinkTimer)) }
}
