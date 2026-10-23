/**
 * Headless screenshots + short WebM of soft avatars on preview.html and the live meeting page.
 * Usage: node scripts/capture-avatar-demo.mjs [--out /opt/cursor/artifacts]
 */
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import http from "node:http"
import { createReadStream, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const outDir = process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : join(root, "demo/out/avatar-capture")
await mkdir(outDir, { recursive: true })

const serve = (dir, port) =>
  new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const path = join(dir, req.url === "/" ? "preview.html" : req.url.replace(/^\//, ""))
      if (!existsSync(path)) {
        res.writeHead(404).end()
        return
      }
      const ext = path.split(".").pop()
      const types = { html: "text/html", js: "text/javascript", css: "text/css", png: "image/png", jpg: "image/jpeg" }
      res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream" })
      createReadStream(path).pipe(res)
    })
    srv.listen(port, "127.0.0.1", () => resolve(srv))
  })

const previewPort = 9876
const previewSrv = await serve(join(root, "demo/web"), previewPort)

let demoProc = null
const demoPort = 8787
demoProc = spawn("npm", ["run", "demo", "--", "--rehearsal", "--host", "127.0.0.1"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, FORCE_COLOR: "0" }
})
await new Promise((r) => setTimeout(r, 8000))

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })

await page.goto(`http://127.0.0.1:${previewPort}/preview.html`, { waitUntil: "networkidle" })
await page.waitForTimeout(600)
await page.screenshot({ path: join(outDir, "preview-page.png"), fullPage: true })
await page.evaluate(() => {
  window.__people[1].say(null, 6, { text: "Database is fine, latency looks normal and stable." })
  window.__people[1].card.classList.add("talking")
})
await page.waitForTimeout(400)
await page.screenshot({ path: join(outDir, "preview-speaking.png") })

await page.goto(`http://127.0.0.1:${demoPort}/?nocam`, { waitUntil: "networkidle" })
await page.click("#start")
await page.waitForTimeout(1200)
await page.screenshot({ path: join(outDir, "meeting-start.png"), fullPage: false })

const framesDir = join(outDir, "frames")
await mkdir(framesDir, { recursive: true })
for (let i = 0; i < 90; i++) {
  await page.screenshot({ path: join(framesDir, `f${String(i).padStart(3, "0")}.png`) })
  await page.waitForTimeout(80)
}
await page.screenshot({ path: join(outDir, "meeting-mid-call.png") })

await browser.close()
previewSrv.close()
demoProc.kill("SIGTERM")

const ffmpeg = spawn(
  "ffmpeg",
  ["-y", "-loglevel", "error", "-framerate", 12.5, "-i", join(framesDir, "f%03d.png"), "-vf", "scale=960:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(outDir, "meeting-mouths.mp4")],
  { stdio: "inherit" }
)
await new Promise((r) => ffmpeg.on("close", r))

console.log("Wrote artifacts to", outDir)
