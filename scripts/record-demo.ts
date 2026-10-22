/**
 * Records the demo to an MP4: a headless browser films the meeting page while the call plays,
 * and the voice clips are mixed into the soundtrack from the run's timestamps (a headless
 * browser records no audio). Needs ffmpeg on PATH and a Chromium (Playwright's cache, or
 * CHROMIUM_PATH). Costs what a demo run costs (see AGENTS.md "Demo").
 *
 *   npx tsx scripts/record-demo.ts                       # template writer, transcript mode
 *   npx tsx scripts/record-demo.ts --writer bedrock --out demo/out/egghead-bedrock.mp4
 *   npx tsx scripts/record-demo.ts --rehearsal --out demo/out/rehearsal.mp4   # no AWS (silent voices)
 */
import { execFileSync, spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { chromium } from "playwright-core"
import { SAMPLE_RATE, wav } from "../demo/Voice.ts"

const { values: args } = parseArgs({
  options: {
    writer: { type: "string", default: "template" },
    mode: { type: "string", default: "text" },
    call: { type: "string", default: "data/calls/checkout-incident.json" },
    out: { type: "string", default: "demo/out/egghead-demo.mp4" },
    port: { type: "string", default: "8788" },
    width: { type: "string", default: "1440" },
    height: { type: "string", default: "900" },
    agent: { type: "string", default: "pi" },
    rehearsal: { type: "boolean", default: false }
  }
})
const base = `http://localhost:${args.port}`
const AUDIO = "demo/out/audio"
const TMP = "demo/out/recording"
mkdirSync(TMP, { recursive: true })

const findChromium = (): string => {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  const cache = join(homedir(), "Library/Caches/ms-playwright")
  for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse()) {
    for (const sub of readdirSync(join(cache, dir))) {
      for (const app of ["Chromium.app/Contents/MacOS/Chromium", "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]) {
        const exe = join(cache, dir, sub, app)
        if (existsSync(exe)) return exe
      }
    }
  }
  throw new Error("No Chromium found: set CHROMIUM_PATH")
}

const server = spawn("npx", ["tsx", "--env-file-if-exists=.env", "demo/server.ts", "--port", args.port!, "--writer", args.writer!, "--mode", args.mode!, "--call", args.call!, "--agent", args.agent!, ...(args.rehearsal ? ["--rehearsal"] : [])], { stdio: ["ignore", "pipe", "inherit"] })
const warm = new Promise<void>((resolve) => server.stdout.on("data", (d: Buffer) => {
  process.stdout.write(d)
  if (/Decider warm/.test(d.toString())) resolve()
}))

try {
  await warm
  const width = Number(args.width), height = Number(args.height)
  const browser = await chromium.launch({ executablePath: findChromium() })
  const context = await browser.newContext({ viewport: { width, height }, recordVideo: { dir: TMP, size: { width, height } } })
  const videoStart = Date.now()
  const page = await context.newPage()
  await page.goto(`${base}/?nocam`) // a headless browser has no camera
  await page.waitForTimeout(1500) // a beat on the empty meeting
  const clickAt = Date.now()
  await page.click("#start")
  await page.locator("#start", { hasText: "Run again" }).waitFor({ timeout: 600_000 })
  await page.waitForTimeout(3000)
  const video = page.video()!
  await context.close()
  await browser.close()
  const webm = await video.path()

  // Soundtrack: every line and Egg Head clip at its time in the video.
  const history = (await (await fetch(`${base}/history`)).json()) as Array<{ type: string; at: number; audio?: string; index?: number }>
  // a line Egg Head cut off stops where it was cut
  const cutAt = new Map(history.filter((m) => m.type === "cut").map((m) => [m.index, m.at]))
  const offsetMs = clickAt - videoStart
  const totalS = (Date.now() - videoStart) / 1000
  const mix = new Int16Array(Math.ceil(totalS * SAMPLE_RATE))
  for (const m of history) {
    if ((m.type !== "line" && m.type !== "egghead") || !m.audio) continue
    const pcm = readFileSync(join(AUDIO, m.audio.replace("/audio/", ""))).subarray(44)
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)
    const at = Math.round(((offsetMs + m.at) / 1000) * SAMPLE_RATE)
    const cut = m.type === "line" ? cutAt.get(m.index) : undefined
    const length = cut === undefined ? samples.length : Math.round(((cut - m.at) / 1000) * SAMPLE_RATE)
    for (let i = 0; i < length && i < samples.length && at + i < mix.length; i++) {
      mix[at + i] = Math.max(-32768, Math.min(32767, mix[at + i]! + samples[i]!))
    }
  }
  const mixPath = join(TMP, "soundtrack.wav")
  writeFileSync(mixPath, wav(new Uint8Array(mix.buffer)))
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-i", mixPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-shortest", args.out!])
  console.log(`wrote ${args.out} (${totalS.toFixed(0)} s)`)
} finally {
  server.kill()
}
