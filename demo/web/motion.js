// Motion for the demo pages: critically damped springs for layout, a bouncy spring when
// something completes, a shake when something goes wrong, a white flash on a state change,
// blur-in for anything new and rolling digits for numbers. No library: springs are simulated
// once and handed to the browser as CSS `linear()` easings.

const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches

/** A damped spring from 0 to 1 as a CSS easing and the time it takes to settle. */
export function spring({ stiffness = 180, damping = 25, mass = 0.8 } = {}) {
  const dt = 1 / 120
  let x = 0, v = 0, t = 0
  const xs = [0]
  while (t < 3) {
    v += ((-stiffness * (x - 1) - damping * v) / mass) * dt
    x += v * dt
    t += dt
    xs.push(x)
    if (Math.abs(1 - x) < 0.0005 && Math.abs(v) < 0.005) break
  }
  xs[xs.length - 1] = 1
  const step = Math.max(1, Math.round(xs.length / 48))
  const pts = xs.filter((_, i) => i % step === 0 || i === xs.length - 1).map((p) => +p.toFixed(4))
  return { easing: `linear(${pts.join(", ")})`, duration: Math.round(t * 1000) }
}

// Presets: `default` for movement, `bouncy` for completion, `snappy` for drawing edges
export const springs = {
  default: spring({ stiffness: 180, damping: 25, mass: 0.8 }),
  bouncy: spring({ stiffness: 260, damping: 18, mass: 1 }),
  snappy: spring({ stiffness: 200, damping: 2 * Math.sqrt(200), mass: 1 })
}
const root = globalThis.document?.documentElement?.style
if (root) for (const [name, s] of Object.entries(springs)) {
  root.setProperty(`--spring-${name}`, s.easing)
  root.setProperty(`--spring-${name}-ms`, `${s.duration}ms`)
}

const run = (el, frames, opts) => (reduced() ? null : el.animate(frames, { fill: "none", ...opts }))

/** Something new: grows in from a blur. */
export function enter(el, { y = 10, scale = 0.94, delay = 0 } = {}) {
  run(el, [{ transform: `translateY(${y}px) scale(${scale})` }, { transform: "none" }], { ...springs.default, delay })
  run(el, [{ opacity: 0, filter: "blur(6px)" }, { opacity: 1, filter: "blur(0)" }], { duration: 260, easing: "ease-out", delay, fill: "backwards" })
}

/** Something finished: a bouncy settle. */
export function pop(el, from = 0.86) {
  run(el, [{ transform: `scale(${from})` }, { transform: "none" }], springs.bouncy)
}

/** Something went wrong: a short, decaying shake. */
export function shake(el, { intensity = 8, count = 6, rotate = 4 } = {}) {
  const r = (n) => (Math.random() - 0.5) * n
  const frames = [{ transform: "none" }]
  for (let i = 0; i < count; i++) {
    const k = 1 - i / count
    frames.push({ transform: `translate(${r(intensity) * k}px, ${r(intensity / 2) * k}px) rotate(${r(rotate) * k}deg)` })
  }
  frames.push({ transform: "none" })
  run(el, frames, { duration: 80 * count + 300, easing: "ease-out" })
}

/** A state change: the element lights up and fades back. Needs `position: relative`. */
export function flash(el, color = "rgba(255,255,255,.55)") {
  const f = document.createElement("i")
  f.className = "fx-flash"
  f.style.background = color
  el.append(f)
  const a = run(f, [{ opacity: 1 }, { opacity: 0 }], { duration: 700, easing: "linear" })
  a ? a.finished.then(() => f.remove(), () => f.remove()) : f.remove()
}

/**
 * Keep `box`'s children in step with `items` ({ key, cls, html }) by key: new ones blur in, moved
 * ones glide to their place (FLIP), changed ones are patched in place. Inside an item, any element
 * with a `data-k` it did not have before is new and pops in, so a tag or state that appears later
 * is the thing that moves. `onChange(el, added)` runs after a patch with the new `data-k` elements.
 */
export function reconcile(box, items, { onEnter = enter, onChange } = {}) {
  const before = new Map()
  for (const c of box.children) if (c.dataset.key) before.set(c.dataset.key, c.getBoundingClientRect().top)
  const old = new Map([...box.children].filter((c) => c.dataset.key).map((c) => [c.dataset.key, c]))
  const fresh = []
  let prev = null
  for (const it of items) {
    let el = old.get(it.key)
    if (el) {
      old.delete(it.key)
      if (el._html === it.html) {
        if (el.className !== it.cls) el.className = it.cls
      } else {
        const had = new Set([...el.querySelectorAll("[data-k]")].map((e) => e.dataset.k))
        el.className = it.cls
        el.innerHTML = it.html
        el._html = it.html
        const added = [...el.querySelectorAll("[data-k]")].filter((e) => !had.has(e.dataset.k))
        added.forEach((e) => (e.matches(".tag, .chip, .state") ? pop(e) : enter(e, { y: 6, scale: 0.96 })))
        onChange?.(el, added)
      }
    } else {
      el = document.createElement(it.tag ?? "div")
      el.dataset.key = it.key
      el.className = it.cls
      el.innerHTML = it.html
      el._html = it.html
      fresh.push(el)
    }
    const want = prev ? prev.nextSibling : box.firstChild
    if (want !== el) box.insertBefore(el, want)
    prev = el
  }
  for (const el of old.values()) el.remove()
  for (const c of box.children) {
    const top = before.get(c.dataset.key)
    if (top === undefined) continue
    const dy = top - c.getBoundingClientRect().top
    if (Math.abs(dy) > 1) run(c, [{ transform: `translateY(${dy}px)` }, { transform: "none" }], springs.default)
  }
  fresh.forEach((el, i) => onEnter(el, { delay: Math.min(i, 6) * 30 }))
}

/** Rolling digits: each digit is a column of 0–9 that springs to its place. */
export function roll(el, value) {
  const text = String(value)
  if (el._roll === text) return
  el._roll = text
  if (!el.classList.contains("roll")) (el.textContent = "", el.classList.add("roll"))
  const cols = [...el.children]
  while (cols.length > text.length) cols.shift().remove()
  while (cols.length < text.length) {
    const c = document.createElement("span")
    c.className = "roll-col"
    c.innerHTML = Array.from({ length: 10 }, (_, d) => `<span>${d}</span>`).join("") + "<span>:</span>"
    el.prepend(c)
    cols.unshift(c)
  }
  ;[...text].forEach((ch, i) => {
    const n = ch === ":" ? 10 : Number(ch)
    cols[i].style.transform = `translateY(${-n}em)`
  })
}

/** Swap a label's text: the old words blur out, the new blur in, and the box springs to its width. */
export function morph(el, text) {
  if (el.textContent === text) return
  const w = el.getBoundingClientRect().width
  el.textContent = text
  if (reduced() || !w) return
  const to = el.getBoundingClientRect().width
  run(el, [{ width: `${w}px` }, { width: `${to}px` }], springs.bouncy)
  run(el, [{ opacity: 0, filter: "blur(4px)" }, { opacity: 1, filter: "blur(0)" }], { duration: 240, easing: "ease-out" })
}
