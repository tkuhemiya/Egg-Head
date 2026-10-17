# Day-1 spike: does Decider 2B answer our questions reliably?

Go/no-go test from [NextSteps.md](../NextSteps.md) §3. The labels in `dataset.jsonl` were written before any model run.

| File | What |
|---|---|
| `dataset.jsonl` | 46 labelled bridge-call moments: 30 for claim routing, 16 with an open flagged claim for the speak gate. 16 are marked `tricky`. |
| `world.json` | What each deterministic check returns during the scripted incident (stands in for CloudWatch). |
| `questions.py` | The §5 questions, option sets, state rendering, §5.3 gates, claim-vs-check comparison, rewording variants. |
| `run.py` | Asks all questions in **one batch per snippet** → `out/results.jsonl` + `out/meta.json`. |
| `eval.py` | → `REPORT.md`: per-question accuracy, accuracy/coverage at confidence ≥ 0.9, calibration, routing-gate and speak-gate precision/recall, latency p50/p95, state-read-once check, rewording, errors, suggested verdict. |

## Run

```bash
pip install strands-decider            # Python ≥ 3.10

# Option A: server (recommended on the Mac; reuse it for the rewording pass)
strands-decider serve StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 --device mps --port 8000
python spike/run.py --url http://127.0.0.1:8000 --hardware-note "M4, MPS"

# Option B: in-process
python spike/run.py --checkpoint --device mps      # or cpu / cuda

python spike/eval.py                                # writes spike/REPORT.md

# Rewording test on the worst 2–3 questions (REPORT.md §6 prints the command)
python spike/run.py --url http://127.0.0.1:8000 --reword is_claim,floor_free
python spike/eval.py
```

`python spike/run.py --dry-run` uses random answers to test the pipeline without the model; the report is stamped as a dry run. It **overwrites** `out/results.jsonl`.

Pass 1 (PROJECT.md wording, T_ROUTE=0.9) is archived in `out/pass1/` and `REPORT-pass1.md`. Pass 2 is `REPORT.md` and `out/pass2/`. **Verdict: GO-with-changes** — see [NextSteps.md](../NextSteps.md) §3.

## Labelling conventions

- `is_claim`: an assertion about *current* system state or a recent change. Guesses, questions, plans, actions and past state are not claims.
- Routing labels (`which_check`, `which_resource`, `asserted_state`) are `null` where the answer is ambiguous (guesses, past state) and are not scored there; chit-chat and actions are labelled `none` / `unknown`.
- A self-correction inside one utterance is labelled by its final assertion.
- `self_repaired`, `silence_cost` and `should_speak` are only labelled for snippets with a flagged claim. Agreeing with a wrong claim is not a repair; questioning it is.
- `silence_cost` is a level index: 0 none, 1 low, 2 moderate, 3 high, 4 critical.
