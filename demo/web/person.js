// Humanoid teammates in the same soft flat style as the egg. Variety comes from a hash of the name.
import { animate, createMouth, el, hash, rng } from "./core.js"

const INK = "#4e403b"
const SKIN = ["#f6dcc6", "#efc9a8", "#e2b28c", "#c99470", "#a87556", "#86593f"]
const HAIR = ["#4a3a33", "#2f2624", "#7a5a44", "#b48a62", "#9a8f8a", "#5b3b36"]
const ACCENT = ["#8fb8c9", "#e6a79a", "#a9c79b", "#c6b0dc", "#efc98a", "#9fc2b5", "#e2b4c8"]
const STYLES = ["short", "bob", "bun", "curly", "long", "side", "beanie", "buzz"]

// Fixed looks for the demo cast so they stay the same between runs.
export const PEOPLE = {
  Priya: { skin: 4, hair: 1, style: "long", accent: 1, headset: true, role: "Incident commander" },
  Jordan: { skin: 1, hair: 2, style: "beanie", accent: 2, role: "Backend" },
  Sam: { skin: 0, hair: 4, style: "bald", accent: 0, glasses: true, role: "Database" },
  Lee: { skin: 3, hair: 1, style: "bob", accent: 3, glasses: true, role: "Release" },
  Mei: { skin: 0, hair: 0, style: "bun", accent: 4, headset: true, role: "SRE" }
}

export function personOf(name, i = 0) {
  const fixed = PEOPLE[name]
  const r = rng(hash(name) + i)
  const pick = (arr) => arr[Math.floor(r() * arr.length)]
  const spec = fixed ?? { skin: Math.floor(r() * SKIN.length), hair: Math.floor(r() * HAIR.length), style: pick(STYLES), accent: Math.floor(r() * ACCENT.length), glasses: r() < 0.25, role: "" }
  const accent = ACCENT[spec.accent % ACCENT.length]
  return { ...spec, skinC: SKIN[spec.skin], hairC: HAIR[spec.hair], accentC: accent }
}

function hairBack(g, p) {
  const f = { fill: p.hairC }
  if (p.style === "long") el("path", { d: "M50 92 C46 150 54 172 70 176 L130 176 C146 172 154 150 150 92 C148 58 128 42 100 42 C72 42 52 58 50 92 Z", ...f }, g)
  if (p.style === "bob") el("path", { d: "M48 96 C46 124 52 138 62 142 L138 142 C148 138 154 124 152 96 C150 60 128 42 100 42 C72 42 50 60 48 96 Z", ...f }, g)
  if (p.style === "bun") el("circle", { cx: 100, cy: 40, r: 15, ...f }, g)
  if (p.style === "curly") for (const [x, y, rr] of [[56, 84, 15], [62, 64, 16], [80, 50, 17], [100, 46, 17], [120, 50, 17], [138, 64, 16], [144, 84, 15]]) el("circle", { cx: x, cy: y, r: rr, ...f }, g)
}

function hairFront(g, p) {
  const f = { fill: p.hairC }
  switch (p.style) {
    case "short": el("path", { d: "M52 92 C52 60 72 46 100 46 C128 46 148 60 148 92 C136 76 118 70 100 72 C82 70 64 76 52 92 Z", ...f }, g); break
    case "long": case "bob": el("path", { d: "M51 92 C52 62 72 46 100 46 C128 46 148 62 149 92 C134 78 116 70 106 68 C96 78 78 86 51 92 Z", ...f }, g); break
    case "bun": el("path", { d: "M51 90 C53 62 74 50 100 50 C126 50 147 62 149 90 C136 74 118 66 100 66 C82 66 64 74 51 90 Z", ...f }, g); break
    case "curly": for (const [x, y, rr] of [[70, 66, 12], [88, 60, 12], [106, 60, 12], [124, 66, 12]]) el("circle", { cx: x, cy: y, r: rr, ...f }, g); break
    case "side": el("path", { d: "M52 94 C50 60 72 46 100 46 C130 46 150 62 148 90 C130 70 96 64 78 70 C66 76 58 84 52 94 Z", ...f }, g); break
    case "beanie":
      el("path", { d: "M50 84 C50 52 72 36 100 36 C128 36 150 52 150 84 Z", fill: p.accentC }, g)
      el("rect", { x: 47, y: 76, width: 106, height: 14, rx: 7, fill: p.accentC, opacity: 1 }, g)
      el("rect", { x: 47, y: 76, width: 106, height: 14, rx: 7, fill: "#fff", opacity: 0.25 }, g)
      el("circle", { cx: 100, cy: 33, r: 7, fill: p.accentC }, g); break
    case "bald": // a shine on top and a little hair over each ear
      el("ellipse", { cx: 86, cy: 60, rx: 16, ry: 7, fill: "#fff", opacity: 0.35, transform: "rotate(-18 86 60)" }, g)
      el("path", { d: "M51 104 C49 90 52 80 58 74 C58 86 58 96 60 106 Z", ...f, opacity: 0.85 }, g)
      el("path", { d: "M149 104 C151 90 148 80 142 74 C142 86 142 96 140 106 Z", ...f, opacity: 0.85 }, g)
      break
    case "buzz": el("path", { d: "M54 86 C56 60 74 48 100 48 C126 48 144 60 146 86 C130 74 116 70 100 70 C84 70 70 74 54 86 Z", ...f, opacity: 0.85 }, g); break
  }
}

/** A teammate. Returns the same API as the egg: { svg, say(marks, durationS, {audio, text}), talk(level), stop(), dispose() }. */
export function drawPerson(name, i = 0) {
  const p = personOf(name, i)
  const svg = el("svg", { viewBox: "24 22 152 178", class: "toon soft", preserveAspectRatio: "xMidYMax meet", "aria-label": name })
  const root = el("g", {}, svg)
  root.style.transformOrigin = "100px 200px"
  // body: soft rounded shoulders, accent shirt, small collar
  el("path", { d: "M42 204 C42 168 66 150 100 150 C134 150 158 168 158 204 Z", fill: p.accentC }, root)
  el("path", { d: "M86 152 Q100 164 114 152", fill: "none", stroke: "#fff", "stroke-width": 3, "stroke-linecap": "round", opacity: 0.55 }, root)
  el("rect", { x: 91, y: 136, width: 18, height: 18, rx: 6, fill: p.skinC }, root)
  el("rect", { x: 91, y: 144, width: 18, height: 6, fill: "#000", opacity: 0.06 }, root)

  const head = el("g", {}, root)
  head.style.transformOrigin = "100px 140px"
  hairBack(head, p)
  for (const x of [52, 148]) el("ellipse", { cx: x, cy: 104, rx: 6, ry: 8, fill: p.skinC }, head) // ears
  el("ellipse", { cx: 100, cy: 98, rx: 48, ry: 46, fill: p.skinC }, head)
  hairFront(head, p)

  for (const x of [74, 126]) el("ellipse", { cx: x, cy: 114, rx: 8, ry: 4.6, fill: "#f2a29b", opacity: 0.6 }, head)
  const eyes = []
  for (const x of [82, 118]) {
    const e = el("g", {}, head)
    e.style.transformOrigin = `${x}px 104px`
    el("circle", { cx: x, cy: 104, r: 4.6, fill: INK }, e)
    el("circle", { cx: x + 1.5, cy: 102.4, r: 1.2, fill: "#fff", opacity: 0.85 }, e)
    eyes.push(e)
  }
  if (p.glasses) for (const x of [82, 118]) el("circle", { cx: x, cy: 104, r: 11, fill: "none", stroke: INK, "stroke-width": 2, opacity: 0.7 }, head)
  if (p.glasses) el("path", { d: "M93 103 Q100 100 107 103", fill: "none", stroke: INK, "stroke-width": 2, opacity: 0.7 }, head)
  const setMouth = createMouth(head, 100, 118, { ink: INK, size: 0.95 })
  if (p.headset) {
    el("path", { d: "M50 100 C46 46 154 46 150 100", fill: "none", stroke: "#8a8290", "stroke-width": 4, "stroke-linecap": "round" }, head)
    el("rect", { x: 44, y: 94, width: 11, height: 18, rx: 5, fill: "#8a8290" }, head)
    el("path", { d: "M50 110 Q58 126 76 124", fill: "none", stroke: "#8a8290", "stroke-width": 2.5, "stroke-linecap": "round" }, head)
  }
  const api = animate(svg, { root, eyes, setMouth, onFrame(t, level) { head.style.transform = `rotate(${(Math.sin(t * 0.7 + i) * 1.2 + level * Math.sin(t * 5) * 1.5).toFixed(2)}deg)` } }, { bobAmp: 1.2, bobSpeed: 0.7, seed: (hash(name) % 1000) / 1000 })
  return Object.assign(api, { person: p })
}
