// Soft flat SVG “room” backgrounds for video-call tiles (muted pastels, no photo realism).
import { el, hash, rng } from "./core.js"

export const ROOM_LABELS = {
  bookshelf: "bookshelf wall",
  window: "window & plant",
  kitchen: "kitchen shelf",
  frame: "framed picture",
  whiteboard: "office whiteboard",
  desk: "home desk",
  couch: "living nook"
}

const CAST = {
  Priya: "bookshelf",
  Jordan: "window",
  Sam: "kitchen",
  Lee: "frame",
  Mei: "whiteboard"
}

const POOL = ["bookshelf", "window", "kitchen", "frame", "whiteboard", "desk", "couch"]

/** Which room scene this teammate’s tile uses. */
export function roomOf(name, i = 0) {
  const id = CAST[name] ?? POOL[Math.floor(rng(hash(name) + i + 17)() * POOL.length)]
  return { id, label: ROOM_LABELS[id] }
}

const wall = (g, fill) => el("rect", { x: 0, y: 0, width: 400, height: 300, fill }, g)

function bookshelf(g) {
  wall(g, "#4a4541")
  el("rect", { x: 0, y: 198, width: 400, height: 102, fill: "#3f3b37" }, g)
  for (const y of [72, 118, 164]) {
    el("rect", { x: 28, y, width: 344, height: 8, rx: 2, fill: "#5e5852" }, g)
    const colors = ["#8a7a8f", "#7a8f9a", "#9a8a7a", "#6a7a8a", "#8f8a7a"]
    for (let i = 0; i < 9; i++) {
      const h = 28 + (i % 3) * 6
      el("rect", { x: 36 + i * 36, y: y - h - 4, width: 22, height: h, rx: 2, fill: colors[i % colors.length], opacity: 0.85 }, g)
    }
  }
  el("rect", { x: 300, y: 48, width: 56, height: 72, rx: 4, fill: "#5a5550", opacity: 0.5 }, g)
}

function windowPlant(g) {
  wall(g, "#525862")
  el("rect", { x: 88, y: 36, width: 168, height: 128, rx: 6, fill: "#a8b8c8" }, g)
  el("rect", { x: 96, y: 44, width: 152, height: 112, rx: 4, fill: "#c5d4e4" }, g)
  el("rect", { x: 168, y: 36, width: 8, height: 128, fill: "#8a96a4", opacity: 0.5 }, g)
  el("rect", { x: 88, y: 96, width: 168, height: 8, fill: "#8a96a4", opacity: 0.5 }, g)
  el("ellipse", { cx: 318, cy: 228, rx: 42, ry: 18, fill: "#4a5a48" }, g)
  el("path", { d: "M318 228 C318 180 302 140 318 108 C334 140 318 180 318 228 Z", fill: "#6a8a68" }, g)
  el("ellipse", { cx: 292, cy: 118, rx: 22, ry: 14, fill: "#7a9a72", opacity: 0.9 }, g)
  el("rect", { x: 308, y: 218, width: 20, height: 36, rx: 6, fill: "#8a7a6a" }, g)
}

function kitchen(g) {
  wall(g, "#4e4a46")
  el("rect", { x: 0, y: 0, width: 400, height: 52, fill: "#5a5550" }, g)
  el("rect", { x: 48, y: 78, width: 304, height: 10, rx: 3, fill: "#6a6560" }, g)
  const jars = ["#9a8a7a", "#7a8a9a", "#8a9a8a", "#a08a7a", "#7a7a8a"]
  for (let i = 0; i < 5; i++) {
    el("rect", { x: 72 + i * 52, y: 52, width: 28, height: 26, rx: 4, fill: jars[i], opacity: 0.75 }, g)
    el("rect", { x: 76 + i * 52, y: 88, width: 20, height: 34, rx: 5, fill: jars[i], opacity: 0.65 }, g)
  }
  el("rect", { x: 52, y: 132, width: 120, height: 8, rx: 2, fill: "#5e5852" }, g)
  el("circle", { cx: 88, cy: 168, rx: 28, ry: 8, fill: "#6a6560", opacity: 0.6 }, g)
}

function frame(g) {
  wall(g, "#504c48")
  el("rect", { x: 118, y: 52, width: 164, height: 120, rx: 4, fill: "#6a6560" }, g)
  el("rect", { x: 128, y: 62, width: 144, height: 100, rx: 2, fill: "#8a9aaa" }, g)
  el("circle", { cx: 168, cy: 98, r: 22, fill: "#c6b0a8", opacity: 0.8 }, g)
  el("path", { d: "M140 148 L200 148 L170 118 Z", fill: "#a8b8a0", opacity: 0.7 }, g)
  el("rect", { x: 0, y: 220, width: 400, height: 80, fill: "#45423e" }, g)
}

function whiteboard(g) {
  wall(g, "#4a4e54")
  el("rect", { x: 0, y: 0, width: 120, height: 300, fill: "#42464c" }, g)
  el("rect", { x: 24, y: 40, width: 352, height: 140, rx: 6, fill: "#9aa0a8" }, g)
  el("rect", { x: 36, y: 52, width: 328, height: 116, rx: 4, fill: "#b8bcc4" }, g)
  for (const [y, w] of [[68, 180], [88, 140], [108, 200], [128, 100]]) {
    el("rect", { x: 52, y, width: w, height: 6, rx: 2, fill: "#8a9098", opacity: 0.55 }, g)
  }
  el("circle", { cx: 320, cy: 100, r: 18, fill: "none", stroke: "#8a9098", "stroke-width": 4, opacity: 0.5 }, g)
}

function desk(g) {
  wall(g, "#48464a")
  el("rect", { x: 48, y: 168, width: 200, height: 12, rx: 3, fill: "#5a585c" }, g)
  el("rect", { x: 72, y: 88, width: 120, height: 80, rx: 6, fill: "#3a383c" }, g)
  el("rect", { x: 80, y: 96, width: 104, height: 64, rx: 4, fill: "#6a7888" }, g)
  el("rect", { x: 260, y: 156, width: 36, height: 28, rx: 6, fill: "#7a6a5a", opacity: 0.8 }, g)
  el("path", { d: "M280 120 L280 156", stroke: "#6a6560", "stroke-width": 4 }, g)
  el("circle", { cx: 280, cy: 112, r: 14, fill: "#c8b890", opacity: 0.7 }, g)
}

function couch(g) {
  wall(g, "#4c4a48")
  el("path", { d: "M40 200 Q40 140 100 128 L300 128 Q360 140 360 200 Z", fill: "#6a6568" }, g)
  el("rect", { x: 56, y: 168, width: 288, height: 48, rx: 12, fill: "#7a7578" }, g)
  el("rect", { x: 320, y: 100, width: 24, height: 100, rx: 8, fill: "#5a5550" }, g)
  el("ellipse", { cx: 332, cy: 88, rx: 28, ry: 20, fill: "#c8b8a0", opacity: 0.55 }, g)
}

const DRAW = { bookshelf, window: windowPlant, kitchen, frame, whiteboard, desk, couch }

/** Full-bleed room SVG for a tile backdrop. */
export function drawRoom(id) {
  const svg = el("svg", {
    viewBox: "0 0 400 300",
    preserveAspectRatio: "xMidYMid slice",
    class: "room-scene",
    "aria-hidden": "true"
  });
  (DRAW[id] ?? bookshelf)(svg)
  return svg
}
