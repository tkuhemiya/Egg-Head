# Agent guide (Egg Head)

Hackathon agent: incident-call bridge that uses **Strands Decider 2B** for fast judgments and **Amazon Bedrock** only when it must speak or escalate. See [`README.md`](README.md) for the problem, the design, results and the open to-do list.

## Layout

| Path | Role |
|------|------|
| `src/` | Runtime, TypeScript on [Effect 4](https://effect.website): Decider provider, questions, gate, checks, `Bridge`, Bedrock (Strands TS) |
| `test/` | Vitest + `@effect/vitest` (`ScriptedDecider` layer; no live Decider or AWS). `test/fixtures/` holds the Python parity oracles |
| `data/world.json` | Mock check world for the demo (`MockSource`); `data/aws.json` is the same incident in AWS CLI shapes, for the agent's stand-in `aws` |
| `scripts/` | `smoke-decider.ts` (short live call), `replay-research.ts` (router vs the research numbers), `probe-bedrock.ts` (two live Bedrock calls), `record-demo.ts` (film the meeting page to an mp4), `aws-usage.sh` (spend from CloudWatch) |
| `demo/` | The demo: meeting page and dashboard (`web/`), real-time call runner, Polly voices (with viseme marks) and Transcribe streaming, the terminal agent (`Agent.ts`, `agent/`: pi extension, system prompt, stand-in `aws` CLI and `egghead` report command). Call scripts are in `data/calls/`; [`demo/RECORDING.md`](demo/RECORDING.md) is the video run sheet |
| `spike/` | Python, frozen. What is left of the Day-1 go/no-go spike: `egghead_gate.py` (the Python gate the research scripts import and `src/Gate.ts` is held to), the pass-2 answers and reports, and the gate parity export |
| `research/decider/` | Decider 2B research campaign (prompting, bias, routing, calibration); see [`FINDINGS.md`](research/decider/FINDINGS.md) |

**Decider research (Oct 2026):** Prefer separate yes/no questions in one batch over N-way choices; rotate or average `choice` option order; use the latest utterance (kv format) for claim detection and Platt-calibrate probabilities on dev before thresholding. Full methods and held-out numbers are in [`research/decider/FINDINGS.md`](research/decider/FINDINGS.md).

## Runtime (TypeScript + Effect)

Node ≥ 22. Python is only for `spike/` and `research/`.

```bash
npm install
npm run check   # tsc --noEmit
npm test        # vitest run
npm run smoke   # live: scripted call through the Bridge, hosted Decider, template writer
npm run replay -- heldout   # live: the router over the research dataset (free hosted Decider)
npm run demo    # dashboard at http://localhost:8787 (Polly voices; see "Demo" below)
scripts/aws-usage.sh        # Bedrock / Polly / Transcribe usage and estimated spend today
```

Effect idioms used throughout (follow them in new code; `node_modules/effect/AGENTS.md` is the reference):

- Services are `Context.Service` classes with `Layer`s; wire with `Layer.provide`. No globals.
- Pure core (`Gate`, `Router`, `Compare`, `Ledger`) is plain functions over immutable data; effects stay at the edges.
- Domain records (`Route`, `GateDecision`, `LedgerItem`, `Event`) are `Schema`s; absent values are `Option` (`OptionFromNullOr`, so JSON shows `null`).
- Untrusted input (Decider responses, `world.json`) is decoded with `Schema`. Errors are tagged (`AiError`, `SupportError`).
- State lives in `Ref`s; `Bridge` serialises `hear`/`tick` with a `Semaphore`. Time comes from `Clock` (use `TestClock` in tests).

**Router = research pipeline:** `src/Questions.ts` and `src/Router.ts` port the frozen research pipeline (FINDINGS.md exp 9 + final_eval): claim from four yes/no layers on the latest line (kv format) combined with the dev-fit logistic weights; code-first resource lookup by alias; check limited to that resource's checks; every choice averaged over option orders; fire at min(claim, resource, check) ≥ 0.25. The gate asks `self_repaired` and Platt-scaled `finished`. `test/Questions.test.ts` holds wording, renderers and combiners to the Python (`research/decider/scripts/export_runtime_parity.py`). `npm run replay -- heldout` reproduced exp 9 exactly on 22 Oct (claim P 0.884 R 0.905; route P 0.806 R 0.806; results in `research/decider/results/runtime_*.json`). A claim the router cannot route is escalated (to Bedrock when wired).

**Parity:** the port is held to the Python runtime it replaced. `test/Parity.test.ts` replays golden fixtures: the gate (the 16 pass-2 snippets, which must still give REPORT-gate.md's numbers, plus a 20k-point input grid from `spike/export_gate_parity.py`) and ten full Bridge traces, replayed as behaviour through the new router (each recorded batch becomes the route and gate signals it implied). Changing gate thresholds, wording or Bridge behaviour on purpose means regenerating the fixture and saying so.

**Agent mode (`src/Investigator.ts`, `src/Conversation.ts`):** give the Bridge an `Investigator` and it (1) sends a contradicted claim that survives one turn uncorrected to the Investigator before the gate may raise it, so a claim the call corrects itself costs no model call; (2) answers when spoken to, once the speaker has finished (`finished` Platt ≥ 0.5 and the words do not trail off; 4 s of silence otherwise), and takes a question to the call that nobody answers in 2.5 s; (3) barges in from `Bridge.partial` (live partial transcripts) when the line names a resource with an open wrong claim and Decider says the speaker is telling someone to act now. Three new yes/no questions (`addr`, `ask` with the gate batch; `act` on partials) have no research numbers yet. Without an Investigator the Bridge is unchanged, so the parity fixtures did not move. `test/Conversation.test.ts` covers it with `Investigator.direct`.

Regenerate the gate fixture after an intentional gate change (no Decider calls, standard library only):

```bash
python3 spike/gate_eval.py            # must still print REPORT-gate.md's numbers
python3 spike/export_gate_parity.py   # writes test/fixtures/gate-parity.json
```

## Strands Decider 2B (hosted API)

Free public endpoint (verified 2026-10-21; `model` became required on 2026-10-22). No signup or API key.

| | |
|--|--|
| Base URL | `https://api.decider.cloud` |
| Model id | `strands-decider-2b` |
| Route | `POST /v1/systemone` — body `{model, state, questions}`; **422 without `model`** |
| Latency | ~130–170 ms server-side per batch of 2–4 questions; ~350 ms round trip from a cloud VM |

**HTTP:** Python’s default `urllib` user agent gets **403**. Always send a named `User-Agent` header (the repo clients do). Since 2026-10-22 the hosted API also rejects a body without `"model": "strands-decider-2b"` (HTTP 422 naming `body.model`).

**Reliability:** Best effort; may go away. Cache responses, keep concurrency modest, use backoff on errors. Measured 22 Oct 2026: a third concurrent request from one client gets **429**, more than **8 questions** per request gets **422 too_long**, and the first request after idle can take **~30 s** (serverless cold start; the demo sends a warm-up). The TS provider queues requests (`maxConcurrent` 1) and splits batches over 8.

**Backend label:** Hosted answers can differ from local HF weights `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610` (likely a different build). Record which backend produced spike numbers (`meta.json` / report headers).

**Option-order bias:** For `choice` questions, ask twice with options reversed and average probabilities.

**Fallback (local):**

```bash
pip install strands-decider
strands-decider serve StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 --port 8000
```

## Pointing Egg Head at Decider

`src/Decider.ts` makes Strands Decider an Effect [`DecisionModel`](https://effect.website) provider: `noul` = `Decision.probability`, `choice` = `Decision.classify`, `score` = `Decision.rate`. Every backend shares one translation and Effect's answer validation (distributions must sum to 1 within Decider's 4-decimal rounding).

- `layerFromEnv`: production wiring from the environment (below)
- `layerFetch({ url, model?, userAgent? })` / `layerHttp(...)`: HTTP `/v1/systemone` with retry on transient errors, timeout and an in-memory cache of identical requests
- `ScriptedDecider.layer(batches)`: replayed answers for tests; `yield* ScriptedDecider` to read the requests it got

Environment:

| Variable | Meaning |
|----------|---------|
| `EGGHEAD_DECIDER_BACKEND` | `public` (default) or `http`. `local` fails with instructions: in-process weights need Python, so run `strands-decider serve` and use `http` |
| `EGGHEAD_DECIDER_URL` | Base URL when `backend=http` (default `http://127.0.0.1:8000`) |
| `EGGHEAD_DECIDER_MODEL` | Sent as `model` when `backend=http` (unset: not sent). `public` always sends `strands-decider-2b` |
| `EGGHEAD_DECIDER_USER_AGENT` | Override User-Agent on HTTP calls |

```bash
# Hosted (default)
export EGGHEAD_DECIDER_BACKEND=public

# Local serve
export EGGHEAD_DECIDER_BACKEND=http
export EGGHEAD_DECIDER_URL=http://127.0.0.1:8000
```

A live agent is `Bridge.layer` over `Decider.layerFromEnv`, `MockSource.layer()` (or an AWS `CheckSource`) and a `Writer` (`Writer.template`, or `BedrockSupport.bridgeServices` for Bedrock + escalation); see `scripts/smoke-decider.ts`. Tests use `ScriptedDecider.layer`.

Bedrock (separate): `EGGHEAD_MODEL_ID` (we use `nvidia.nemotron-nano-3-30b`: tool use and structured output both work through Strands, ~1.5–3 s per call), `AWS_REGION`, and `AWS_BEARER_TOKEN_BEDROCK` (a Bedrock API key) or the usual credential chain; keep them in `.env` (gitignored) — see `src/Bedrock.ts` (Strands TS `Agent`, `SpeakGuard` is the `InterventionHandler`; a denied `beforeModelCall` never reaches the model, tested against a real Strands agent).

## Demo

```bash
npm run demo                          # Decider + pi on Bedrock in a live terminal + Polly voices
npm run demo -- --rehearsal           # no network at all: scripted Decider and pi model, silent voices
npm run demo -- --agent none          # no agent: Egg Head speaks from the fast checks (the old behaviour)
npm run demo -- --agent-cmd "claude"  # any other terminal coding agent (same PATH, prompts and report command)
npm run demo -- --agent-model qwen.qwen3-coder-30b-a3b-v1:0   # pi's Bedrock model (default: EGGHEAD_AGENT_MODEL, else EGGHEAD_MODEL_ID)
npm run demo -- --writer bedrock      # Bedrock routes claims Decider could not (escalations)
npm run demo -- --mode transcribe     # Amazon Transcribe streaming hears the call audio
```

http://localhost:8787 is the meeting: five cartoon teammates who lip-sync to their Polly voices (viseme speech marks), your camera (video only; `?me=Name` labels the tile, `?nocam` skips it), Egg Head's tile with what it is doing now, live captions, a feed of every decision, and the coding agent's real terminal (node-pty, xterm.js), which grows while the agent works. Both pages share `demo/web/theme.css` (near-black neutrals, mono labels, one colour per state) and `demo/web/motion.js` (springs as CSS `linear()` easings; blur-in, bouncy pop, shake, flash, rolling digits, keyed FLIP lists); `prefers-reduced-motion` turns the motion off. http://localhost:8787/dashboard is the run dashboard: a decision tree (`demo/web/tree.js`: every way a line can go; pick a line and its path lights up with Decider's scores against the thresholds, following a claim through second look, agent and gate; "Whole run" counts the lines down each branch, and clicking a node marks those lines), the transcript with what each line triggered (Decider scores, the fast check, the gate's six reasons, agent tasks, what Egg Head said or why it stayed quiet), plus the claims, agent tasks and questions; `?replay` shows the last run. Press Start on either page.

What the call shows (`data/calls/checkout-incident.json`; each line has `expect` and the Decider answers `--rehearsal` uses):

- **Quiet:** true claims (fast check agrees, no LLM), a question someone else answers, a false claim the call corrects itself (no LLM call at all).
- **Second look, then speak at a gap:** a contradicted claim that survives one turn goes to the agent (pi runs the stand-in `aws`, then `egghead report`); the gate only considers it once confirmed. Lines with `waitForEggHead` hold the people until Egg Head has said its piece.
- **Spoken to:** "Egg Head, can you check the, uh…" then a 1.7 s pause: Decider says not finished (and the words trail off), so it waits; it replies once Priya finishes ("On it"), and answers at the next gap.
- **A hanging question:** nobody answers for 2.5 s, so Egg Head takes it.
- **Barge-in:** while a line plays, the runner feeds words as partial transcripts (Polly word marks) to `Bridge.partial`; a resource with an open wrong claim (code) plus Decider's "telling someone to act now" cuts the speaker off.

The agent's shell has `demo/agent/bin` first on PATH: `aws` is a stand-in that answers from `data/aws.json` in real CLI shapes (alarms, metrics, RDS, SQS, ECS deploys, `--query`, `--output text`), and `egghead report|answer` POSTs the result to `/agent/report`. Jobs run one at a time with a timeout (`--agent-timeout`, 60 s); on a timeout the Bridge falls back to the direct check. Runs are saved to `demo/out/runs/`, voice clips and marks cached in `demo/out/audio/` (re-runs cost no Polly), pi's settings live in `demo/out/agent/`.

To make a video file instead of screen-recording: `EGGHEAD_VOICE_REGION=ap-south-1 npx tsx scripts/record-demo.ts --out demo/out/egghead-demo.mp4` films the meeting page with headless Chromium (Playwright's cache) and mixes the voice clips into the soundtrack from the run's timestamps (needs `ffmpeg`; `--rehearsal` works too).

Polly and Transcribe use the default AWS credential chain (`aws login` works); a Bedrock API key does not cover them. Set `EGGHEAD_VOICE_REGION` to the region nearest you: Egg Head's line is synthesised mid-call, and from Colombo Polly took ~0.3 s in ap-south-1 vs ~2.2 s in us-east-1. Bedrock writing takes ~2.5–3.5 s (Nemotron Nano 3, temperature 0.2); the gate holds the floor meanwhile and the dashboard shows "taking the floor". Transcribe has no CloudWatch metrics, so the runner logs streamed seconds for `scripts/aws-usage.sh`. Costs per run, before free tier: Polly ~$0.01 the first time, Transcribe ~$0.02, Bedrock < $0.001.
