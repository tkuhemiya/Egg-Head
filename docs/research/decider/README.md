# decider-research

Experiments on how to branch and phrase Strands Decider 2B questions for Egg-Head. Results are in **FINDINGS.md**.

## Layout
- `data/dataset.jsonl`: 273 labelled lines (`split`: dev/heldout), frozen, see `FROZEN.sha256`. `data/sequences.json`: 24 correction sequences (`FROZEN_sequences_v2.sha256`). `data/source/`: inputs used by `scripts/build_dataset.py` (`egghead_spike.jsonl` is also the Day-1 spike's labelled set).
- `scripts/lib.py`: API client with disk cache (`results/cache/`), raw log (`results/raw.jsonl`), retries/backoff and metrics. `scripts/common.py`: state rendering, question wordings, checks. `scripts/final_platt.py`: the dev Platt scaling shared by exp 9 and 10.
- `scripts/expN_*.py`: experiments 1–11 (exp 9: claim and routing recall; exp 10: Decider prompting techniques; exp 11: LLM-baseline prompting). `analyse_exp2.py` summarises exp2. `final_eval.py` runs the pipeline vs baselines.
- `scripts/llm_baseline.py`, `scripts/llm_gate.py`: the LLM-on-every-line baseline (Nemotron 3 Super 120B on OpenRouter; key from `~/.secrets/openrouter.env`).
- `scripts/export_runtime_parity.py`: writes `test/fixtures/research-parity.json` for the TypeScript port (no Decider calls).
- `results/expN_{dev,heldout}.json|.log`, `results/final_{dev,heldout}.json`, `results/llm_*.json`, `results/PREREGISTERED*.json`. `results/runtime_{dev,heldout}.json` are the TypeScript router's replay (`npm run replay`).

## Rerun
```bash
cd scripts
sha256sum -c ../data/FROZEN.sha256          # data unchanged
python3 exp1_phrasing.py dev                 # likewise exp2_order, exp3_branching, exp4_routing, exp5_ensemble, exp7_turns, exp8_batch
python3 analyse_exp2.py dev
python3 exp6_calibration.py dev              # fits Platt params -> results/exp6_platt_dev.json (needed by exp9, exp10, final_eval)
python3 exp9_recall.py dev                   # likewise exp10_prompting, exp11_llm, llm_baseline, llm_gate
python3 final_eval.py dev                    # sanity check
python3 final_eval.py heldout                # already run once; do not tune on it (same for every `heldout` arg)
```
`final_eval.py` and `exp10_prompting.py` import the frozen Python gate from `test/oracles/egghead_gate.py` (the runtime is TypeScript now; `src/domain/Gate.ts` is held to it by a parity test). Cached requests cost nothing. New ones go to the public API with concurrency 2 and a named User-Agent. Python 3.10+, standard library only.
