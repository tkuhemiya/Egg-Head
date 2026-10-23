/**
 * Sound: a line of speech seen as how long it takes and when each word lands. The call loop
 * (Call.ts) needs only this, so it runs the same with Polly voices (demo/Voice.ts) or with
 * estimated timings and no audio (offline scenarios).
 */
import { Context, Effect, Layer, Schema } from "effect"

const Mark = Schema.Struct({ time: Schema.Number, value: Schema.String })

/** When each word and mouth shape (viseme) starts, in ms from the start of the line. */
export const Marks = Schema.Struct({ words: Schema.Array(Mark), visemes: Schema.Array(Mark) })
export type Marks = typeof Marks.Type

export interface Spoken {
  readonly durationS: number
  readonly marks: Marks
  /** URL the meeting page plays; "" when there is no audio. */
  readonly audio: string
}

export class Sound extends Context.Service<Sound, {
  speak(voice: string, text: string): Effect.Effect<Spoken>
}>()("egghead/Sound") {
  /** Words at a speaking pace, no audio. */
  static readonly estimated = Layer.succeed(Sound, Sound.of({
    speak: (_voice, text) => Effect.sync(() => ({ ...estimateMarks(text), audio: "" }))
  }))
}

/** Words at a speaking pace, mouth shapes guessed from letters. Close enough for a cartoon mouth. */
export const estimateMarks = (text: string): { readonly marks: Marks; readonly durationS: number } => {
  const words: Array<{ time: number; value: string }> = []
  const visemes: Array<{ time: number; value: string }> = []
  let t = 80
  for (const w of text.split(/\s+/).filter(Boolean)) {
    words.push({ time: t, value: w })
    const letters = w.toLowerCase().replace(/[^a-z0-9]/g, "") || "a"
    const per = Math.max(45, Math.min(90, 330 / letters.length))
    for (const ch of letters) {
      visemes.push({ time: Math.round(t), value: LETTER_VISEME[ch] ?? "@" })
      t += per
    }
    visemes.push({ time: Math.round(t), value: "sil" })
    t += /[,.;:?!]$/.test(w) ? 260 : 70
  }
  return { marks: { words, visemes }, durationS: (t + 200) / 1000 }
}

const LETTER_VISEME: Readonly<Record<string, string>> = {
  a: "a", e: "e", i: "i", o: "o", u: "u", y: "i", w: "u", b: "p", m: "p", p: "p", f: "f", v: "f",
  t: "t", d: "t", n: "t", l: "t", s: "s", z: "s", c: "k", k: "k", g: "k", q: "k", x: "k", h: "k",
  r: "r", j: "S"
}
