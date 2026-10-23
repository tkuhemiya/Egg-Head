/**
 * Render the README's diagrams: every docs/diagrams/*.mmd (Mermaid) becomes an .svg beside it,
 * drawn by Pele (https://github.com/obsidianmd/pele), with no browser and no Mermaid.js.
 *
 *   npx tsx scripts/diagrams.ts
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { render } from "pele"

const DIR = new URL("../docs/diagrams/", import.meta.url)

for (const file of readdirSync(DIR).filter((f) => f.endsWith(".mmd")).sort()) {
  const { svg } = render(readFileSync(new URL(file, DIR), "utf8"), { fontFamily: "Helvetica, Arial, sans-serif" })
  // GitHub shows an SVG as an image on its own page colour; paint the diagram's background so
  // the dark lines stay readable in dark mode.
  const painted = svg.replace(/(<svg[^>]*>)/, `$1<rect width="100%" height="100%" rx="8" fill="var(--_bg)"/>`)
  const out = file.replace(/\.mmd$/, ".svg")
  writeFileSync(new URL(out, DIR), painted)
  console.log(`docs/diagrams/${out}`)
}
