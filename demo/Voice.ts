/**
 * Demo audio: Amazon Polly voices (cached on disk, so a re-run costs nothing) and Amazon
 * Transcribe streaming. Both use the default AWS credential chain (e.g. `aws login`); a
 * Bedrock API key does not work for them. Transcribe seconds are appended to
 * spike/out/transcribe-seconds.log so scripts/aws-usage.sh can count them.
 */
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly"
import { StartStreamTranscriptionCommand, TranscribeStreamingClient } from "@aws-sdk/client-transcribe-streaming"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"

export const SAMPLE_RATE = 16000
const OUT = new URL("./out/audio/", import.meta.url)
const TRANSCRIBE_LOG = new URL("../spike/out/transcribe-seconds.log", import.meta.url)

export class AudioError extends Schema.TaggedError<AudioError>()("AudioError", {
  operation: Schema.Literals(["synthesize", "transcribe"]),
  cause: Schema.Defect()
}) {}

export interface Clip {
  readonly file: string // name under demo/out/audio/
  readonly pcm: Uint8Array // 16-bit mono PCM at SAMPLE_RATE
  readonly durationS: number
}

/** 16-bit mono PCM -> WAV bytes, for the browser. */
export const wav = (pcm: Uint8Array): Uint8Array => {
  const header = new DataView(new ArrayBuffer(44))
  const text = (o: number, s: string) => [...s].forEach((c, i) => header.setUint8(o + i, c.charCodeAt(0)))
  text(0, "RIFF")
  header.setUint32(4, 36 + pcm.length, true)
  text(8, "WAVEfmt ")
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true)
  header.setUint16(22, 1, true)
  header.setUint32(24, SAMPLE_RATE, true)
  header.setUint32(28, SAMPLE_RATE * 2, true)
  header.setUint16(32, 2, true)
  header.setUint16(34, 16, true)
  text(36, "data")
  header.setUint32(40, pcm.length, true)
  const out = new Uint8Array(44 + pcm.length)
  out.set(new Uint8Array(header.buffer), 0)
  out.set(pcm, 44)
  return out
}

export class Voice extends Context.Service<Voice, {
  /** Polly neural voice for `text`, from the disk cache when this exact line was made before. */
  speak(voice: string, text: string): Effect.Effect<Clip, AudioError>
  /** Characters sent to Polly in this process (cache hits are free). */
  readonly charactersBilled: Effect.Effect<number>
}>()("egghead/demo/Voice") {
  static readonly layer = Layer.sync(Voice, () => {
    const polly = new PollyClient({})
    let billed = 0
    mkdirSync(OUT, { recursive: true })
    return Voice.of({
      speak: (voice, text) =>
        Effect.gen(function*() {
          const file = `${createHash("sha256").update(`${voice}\n${text}`).digest("hex").slice(0, 16)}.wav`
          const path = new URL(file, OUT)
          if (existsSync(path)) {
            const pcm = readFileSync(path).subarray(44)
            return { file, pcm, durationS: pcm.length / 2 / SAMPLE_RATE }
          }
          const pcm = yield* Effect.tryPromise({
            try: async (signal) => {
              const res = await polly.send(
                new SynthesizeSpeechCommand({
                  Engine: "neural",
                  OutputFormat: "pcm",
                  SampleRate: String(SAMPLE_RATE),
                  Text: text,
                  VoiceId: voice as never
                }),
                { abortSignal: signal }
              )
              return res.AudioStream!.transformToByteArray()
            },
            catch: (cause) => new AudioError({ operation: "synthesize", cause })
          })
          billed += text.length
          writeFileSync(path, wav(pcm))
          return { file, pcm, durationS: pcm.length / 2 / SAMPLE_RATE }
        }),
      charactersBilled: Effect.sync(() => billed)
    })
  })
}

export interface Segment {
  readonly text: string
  readonly startS: number
  readonly endS: number
}

/**
 * Stream PCM to Transcribe in real time and emit each final segment. `audio` yields chunks
 * of PCM; pace it at real time (Transcribe rejects audio sent much faster than it plays).
 */
export const transcribe = (audio: AsyncIterable<Uint8Array>): Stream.Stream<Segment, AudioError> =>
  Stream.fromAsyncIterable(
    (async function*() {
      const client = new TranscribeStreamingClient({})
      const started = Date.now()
      let sent = 0
      const events = (async function*() {
        for await (const chunk of audio) {
          sent += chunk.length
          yield { AudioEvent: { AudioChunk: chunk } }
        }
      })()
      try {
        const res = await client.send(new StartStreamTranscriptionCommand({
          LanguageCode: "en-US",
          MediaEncoding: "pcm",
          MediaSampleRateHertz: SAMPLE_RATE,
          AudioStream: events
        }))
        for await (const ev of res.TranscriptResultStream ?? []) {
          for (const r of ev.TranscriptEvent?.Transcript?.Results ?? []) {
            if (r.IsPartial) continue
            const text = r.Alternatives?.[0]?.Transcript?.trim()
            if (text) yield { text, startS: r.StartTime ?? 0, endS: r.EndTime ?? 0 }
          }
        }
      } finally {
        const seconds = sent / 2 / SAMPLE_RATE
        mkdirSync(new URL(".", TRANSCRIBE_LOG), { recursive: true })
        appendFileSync(TRANSCRIBE_LOG, `${new Date(started).toISOString()} ${seconds.toFixed(1)}\n`)
      }
    })(),
    (cause) => new AudioError({ operation: "transcribe", cause })
  )
