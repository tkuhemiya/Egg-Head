# Agent guide (Egg Head)

Hackathon agent: incident-call bridge that uses **Strands Decider 2B** for fast judgments and **Amazon Bedrock** only when it must speak or escalate. See `PROJECT.md` for design; `NextSteps.md` for status.

## Layout

| Path | Role |
|------|------|
| `egghead/` | Runtime: Decider client, questions, gate, checks, `Bridge`, Bedrock speaker |
| `tests/` | Unit tests (`ScriptedDecider` stubs; no live Decider or AWS) |
| `spike/` | Day-1 eval harness, labeled snippets, saved reports under `spike/out/` |
| `research/decider/` | Decider 2B research campaign (prompting, bias, routing, calibration); see [`FINDINGS.md`](research/decider/FINDINGS.md) |

**Decider research (Oct 2026):** Prefer separate yes/no questions in one batch over N-way choices; rotate or average `choice` option order; use the latest utterance (kv format) for claim detection and Platt-calibrate probabilities on dev before thresholding. Full methods and held-out numbers are in [`research/decider/FINDINGS.md`](research/decider/FINDINGS.md).

## Tests

```bash
python3 -m unittest discover -s tests -t .
```

`tests/test_bedrock.py` needs the `strands` package (Bedrock path). Gate and bridge tests run without Decider or AWS.

Spike pipeline (optional, hits a real Decider):

```bash
cd spike && pip install -r requirements.txt
python3 run.py --url https://api.decider.cloud --limit 3
python3 eval.py
```

## Strands Decider 2B (hosted API)

Free public endpoint (verified 2026-10-21). No signup or API key.

| | |
|--|--|
| Base URL | `https://api.decider.cloud` |
| Model id | `strands-decider-2b` |
| Route | `POST /v1/systemone` — same JSON body as `strands-decider serve` |
| Latency | ~130–170 ms server-side per batch of 2–4 questions; ~350 ms round trip from a cloud VM |

**HTTP:** Python’s default `urllib` user agent gets **403**. Always send a named `User-Agent` header (the repo clients do).

**Reliability:** Best effort; may go away. Cache responses, keep concurrency modest, use backoff on errors.

**Backend label:** Hosted answers can differ from local HF weights `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610` (likely a different build). Record which backend produced spike numbers (`meta.json` / report headers).

**Option-order bias:** For `choice` questions, ask twice with options reversed and average probabilities.

**Fallback (local):**

```bash
pip install strands-decider
strands-decider serve StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 --port 8000
```

## Pointing Egg Head at Decider

Code lives in `egghead/decider.py`:

- `HttpDecider(url)` — HTTP `/v1/systemone`
- `LocalDecider(checkpoint, device)` — in-process engine
- `ScriptedDecider(...)` — fixed answers for tests
- `decider_from_env()` — production-style wiring from env

Environment:

| Variable | Meaning |
|----------|---------|
| `EGGHEAD_DECIDER_BACKEND` | `public` (default), `http`, or `local` |
| `EGGHEAD_DECIDER_URL` | Base URL when `backend=http` (default `http://127.0.0.1:8000`) |
| `EGGHEAD_DECIDER_CHECKPOINT` | HF id/path when `backend=local` |
| `EGGHEAD_DECIDER_DEVICE` | `cpu` / `mps` / `cuda` for local (default `cpu`) |
| `EGGHEAD_DECIDER_USER_AGENT` | Override User-Agent on HTTP calls |

Examples:

```bash
# Hosted (default for decider_from_env)
export EGGHEAD_DECIDER_BACKEND=public

# Local serve
export EGGHEAD_DECIDER_BACKEND=http
export EGGHEAD_DECIDER_URL=http://127.0.0.1:8000

# In-process weights
export EGGHEAD_DECIDER_BACKEND=local
```

Wire `Bridge(decider=decider_from_env(), ...)` when building a live agent. Tests keep using `ScriptedDecider`.

Bedrock (separate): `EGGHEAD_MODEL_ID`, `AWS_REGION` — see `egghead/bedrock.py`.
