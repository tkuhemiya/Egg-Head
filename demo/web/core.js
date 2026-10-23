// Shared bits for the soft avatars: SVG helper, the 3-shape mouth, and the animation driver
// (idle bob, breathing, blink, speech onset squash, mouth level from audio / visemes / text).

export const NS = "http://www.w3.org/2000/svg"
let uid = 0
export const nextId = (p) => `${p}${++uid}`

export const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  if (parent) parent.append(e)
  return e
}

const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x))
const lerp = (a, b, t) => a + (b - a) * t

// Mouth: closed smile at level 0, small "o" around 0.45, medium "o" at 1. No teeth, no lips.
export function createMouth(parent, cx, cy, { ink = "#5a4a44", fill = "#e8857f", size = 1 } = {}) {
  const g = el("g", { transform: `translate(${cx} ${cy}) scale(${size})` }, parent)
  const smile = el("path", { d: "M-5 -1 Q0 3.6 5 -1", fill: "none", stroke: ink, "stroke-width": 1.9, "stroke-linecap": "round" }, g)
  const o = el("ellipse", { cx: 0, cy: 0.5, rx: 2.6, ry: 1, fill }, g)
  const set = (level) => {
    const open = clamp((level - 0.08) / 0.92)
    smile.setAttribute("opacity", (1 - clamp(open * 3)).toFixed(3))
    o.setAttribute("opacity", clamp(open * 3).toFixed(3))
    o.setAttribute("rx", lerp(2.8, 4.2, open).toFixed(2))
    o.setAttribute("ry", lerp(1.6, 5.6, open).toFixed(2))
    o.setAttribute("cy", lerp(0.4, 1.6, open).toFixed(2))
  }
  set(0)
  return set
}

// Polly viseme -> mouth level (3 buckets only, on purpose)
const VIS = { sil: 0, p: 0.05, f: 0.3, t: 0.4, S: 0.4, T: 0.4, s: 0.35, k: 0.45, r: 0.55, i: 0.5, e: 0.7, E: 0.75, a: 1, "@": 0.8, o: 0.85, O: 0.95, u: 0.6 }

// One AudioContext shared by all avatars; one source node per <audio> element (browser rule).
let ctx = null
const sources = new WeakMap()
function analyserFor(audio) {
  try {
    ctx ??= new (window.AudioContext || window.webkitAudioContext)()
    if (ctx.state === "suspended") ctx.resume()
    let node = sources.get(audio)
    if (!node) {
      const src = ctx.createMediaElementSource(audio)
      const an = ctx.createAnalyser()
      an.fftSize = 1024
      src.connect(an)
      an.connect(ctx.destination)
      node = { an, buf: new Float32Array(an.fftSize) }
      sources.set(audio, node)
    }
    return () => {
      node.an.getFloatTimeDomainData(node.buf)
      let s = 0
      for (const v of node.buf) s += v * v
      return clamp((Math.sqrt(s / node.buf.length) - 0.01) * 7) // rms -> 0..1
    }
  } catch {
    return null
  }
}

// Text rhythm fallback: open on vowel groups, close on spaces/punctuation, ~11 chars/s.
function textLevelFn(text, durationS) {
  const chars = [...(text || "la la la la la la la la")]
  const rate = durationS ? chars.length / durationS : 13
  return (t) => {
    const i = Math.floor(t * rate)
    if (i >= chars.length) return 0
    const c = chars[i].toLowerCase()
    if (" ,.;:!?-".includes(c)) return 0
    if ("aeo".includes(c)) return 0.95
    if ("iuy".includes(c)) return 0.6
    return 0.3
  }
}

/**
 * Animation driver. parts: { root (bob/squash group), eyes [<g>], setMouth, onFrame?(t, level) }
 * Returns { say(marks, durationS, opts), talk(level), stop(), dispose() }.
 */
export function animate(svg, parts, { bobAmp = 2.2, bobSpeed = 0.9, seed = Math.random() } = {}) {
  let raf = 0, alive = true
  let level = 0, source = null, endAt = 0, startAt = 0, manual = null
  let blinkAt = performance.now() + 800 + seed * 3000, blinkUntil = 0
  let squashAt = -1e9
  const phase = seed * 6.28

  const frame = (now) => {
    if (!alive) return
    const t = now / 1000
    // target mouth level
    let target = 0
    if (manual != null) target = manual
    else if (source && now < endAt) target = source(Math.max(0, now - startAt) / 1000)
    else if (source) { source = null; svg.classList.remove("talking") }
    // attack fast, release slower: soft, never snappy
    level += (target - level) * (target > level ? 0.45 : 0.18)
    if (level < 0.002) level = 0
    parts.setMouth(level)

    // blink: quick (~130ms), every 2-6 s, sometimes a double
    if (now > blinkAt) {
      blinkUntil = now + 130
      blinkAt = now + 2000 + Math.random() * 4000
      if (Math.random() < 0.15) blinkAt = now + 260
    }
    const closed = now < blinkUntil ? Math.sin(((blinkUntil - now) / 130) * Math.PI) : 0
    for (const e of parts.eyes) e.style.transform = `scaleY(${(1 - 0.88 * closed).toFixed(3)})`

    // idle bob + breathing, plus a little squash-and-bounce on speech onset
    const bob = Math.sin(t * bobSpeed * 2 + phase) * bobAmp
    const breath = 1 + Math.sin(t * bobSpeed * 2 + phase + 1.2) * 0.008
    const k = (now - squashAt) / 1000
    const sq = k < 0.5 ? Math.exp(-k * 9) * Math.sin(k * 26) * 0.045 : 0
    const talkBob = level * 1.2
    parts.root.style.transform = `translateY(${(bob - talkBob).toFixed(2)}px) scale(${(breath + sq).toFixed(4)}, ${(breath - sq).toFixed(4)})`
    parts.onFrame?.(t, level)
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  const begin = (fn, durationS) => {
    startAt = performance.now()
    endAt = startAt + durationS * 1000
    source = fn
    squashAt = startAt
    svg.classList.add("talking")
  }

  return {
    svg,
    /** Same signature as the old avatars.js say(marks, durationS); opts.audio = HTMLAudioElement, opts.text = line text. */
    say(marks, durationS = 3, opts = {}) {
      manual = null
      const amp = opts.audio ? analyserFor(opts.audio) : null
      const vis = marks?.visemes?.length ? marks.visemes : null
      let fn
      if (amp) fn = () => amp()
      else if (vis) {
        let i = 0
        fn = (t) => {
          const ms = t * 1000
          if (ms < (vis[i]?.time ?? 0)) i = 0
          while (i + 1 < vis.length && vis[i + 1].time <= ms) i++
          const base = VIS[vis[i].value] ?? 0.4
          return base * (0.85 + 0.15 * Math.sin(t * 40)) // tiny wobble so held vowels aren't frozen
        }
      } else fn = textLevelFn(opts.text, durationS)
      begin(fn, durationS)
    },
    /** Drive the mouth directly (0..1), e.g. your own analyser. Pass null to release. */
    talk(v) {
      if (manual == null && v != null) squashAt = performance.now()
      manual = v
    },
    stop() { source = null; manual = null; svg.classList.remove("talking") },
    dispose() { alive = false; cancelAnimationFrame(raf) },
    get level() { return level }
  }
}

export function hash(str) {
  let h = 2166136261
  for (const c of String(str)) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}
export function rng(seed) {
  let s = seed || 1
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909)), ((s ^= s >>> 16) >>> 0) / 4294967296)
}
