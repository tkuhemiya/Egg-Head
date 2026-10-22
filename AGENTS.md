# Agent guide (Egg Head)

Hackathon agent: incident-call bridge that uses **Strands Decider 2B** for fast judgments and **Amazon Bedrock** only when it must speak or escalate. See `PROJECT.md` for design; `NextSteps.md` for status.

## Layout

| Path | Role |
|------|------|
| `src/` | Runtime, TypeScript on [Effect 4](https://effect.website): Decider provider, questions, gate, checks, `Bridge`, Bedrock (Strands TS) |
| `test/` | Vitest + `@effect/vitest` (`ScriptedDecider` layer; no live Decider or AWS). `test/fixtures/` holds the Python parity oracles |
| `data/world.json` | Mock check world for the demo (`MockSource`) |
| `scripts/` | `smoke-decider.ts`: a short call through the Bridge against a real Decider |
| `spike/` | Python. Day-1 eval harness, labeled snippets, saved reports under `spike/out/`; `egghead_gate.py` is the frozen Python gate the research scripts import |
| `research/decider/` | Decider 2B research campaign (prompting, bias, routing, calibration); see [`FINDINGS.md`](research/decider/FINDINGS.md) |

**Decider research (Oct 2026):** Prefer separate yes/no questions in one batch over N-way choices; rotate or average `choice` option order; use the latest utterance (kv format) for claim detection and Platt-calibrate probabilities on dev before thresholding. Full methods and held-out numbers are in [`research/decider/FINDINGS.md`](research/decider/FINDINGS.md).

## Runtime (TypeScript + Effect)

Node ≥ 22. Python is only for `spike/` and `research/`.

```bash
npm install
npm run check   # tsc --noEmit
npm test        # vitest run
npm run smoke   # live: scripted call through the Bridge, hosted Decider, template writer
```

Effect idioms used throughout (follow them in new code; `node_modules/effect/AGENTS.md` is the reference):

- Services are `Context.Service` classes with `Layer`s; wire with `Layer.provide`. No globals.
- Pure core (`Gate`, `Router`, `Compare`, `Ledger`) is plain functions over immutable data; effects stay at the edges.
- Domain records (`Route`, `GateDecision`, `LedgerItem`, `Event`) are `Schema`s; absent values are `Option` (`OptionFromNullOr`, so JSON shows `null`).
- Untrusted input (Decider responses, `world.json`) is decoded with `Schema`. Errors are tagged (`AiError`, `SupportError`).
- State lives in `Ref`s; `Bridge` serialises `hear`/`tick` with a `Semaphore`. Time comes from `Clock` (use `TestClock` in tests).

**Parity:** the port is held to the Python runtime it replaced. `test/Parity.test.ts` replays golden fixtures: the gate (the 16 pass-2 snippets, which must still give REPORT-gate.md's numbers, plus a 20k-point input grid from `spike/export_gate_parity.py`), the exact question wording and option order, and ten full Bridge traces. Changing gate thresholds, wording or Bridge behaviour on purpose means regenerating the fixture and saying so.

Spike pipeline (optional, hits a real Decider):

```bash
cd spike && pip install -r requirements.txt
python3 run.py --url https://api.decider.cloud --limit 3
python3 eval.py
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

**Reliability:** Best effort; may go away. Cache responses, keep concurrency modest, use backoff on errors.

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

Bedrock (separate): `EGGHEAD_MODEL_ID`, `AWS_REGION` — see `src/Bedrock.ts` (Strands TS `Agent`, `SpeakGuard` is the `InterventionHandler`; a denied `beforeModelCall` never reaches the model, tested against a real Strands agent).
