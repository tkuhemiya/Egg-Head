# decider-research

Experiments on how to branch and phrase Strands Decider 2B questions for Egg-Head. Results are in **FINDINGS.md**.

## Layout
- `data/dataset.jsonl`: 273 labelled lines (`split`: dev/heldout), frozen, see `FROZEN.sha256`. `data/sequences.json`: 24 correction sequences (`FROZEN_sequences_v2.sha256`). `data/source/`: inputs used by `scripts/build_dataset.py`.
- `scripts/lib.py`: API client with disk cache (`results/cache/`), raw log (`results/raw.jsonl`), retries/backoff and metrics. `scripts/common.py`: state rendering, question wordings, checks.
- `scripts/expN_*.py`: experiments 1–8. `analyse_exp2.py` summarises exp2. `final_eval.py` runs the pipeline vs baselines.
- `results/expN_dev.json|.log`, `results/final_{dev,heldout}.json`, `results/PREREGISTERED.json`.

## Rerun
```bash
cd scripts
sha256sum -c ../data/FROZEN.sha256          # data unchanged
python3 exp1_phrasing.py dev                 # likewise exp2_order, exp3_branching, exp4_routing, exp5_ensemble, exp7_turns, exp8_batch
python3 analyse_exp2.py dev
python3 exp6_calibration.py dev              # fits Platt params -> results/exp6_platt_dev.json (needed by final_eval)
python3 final_eval.py dev                    # sanity check
python3 final_eval.py heldout                # already run once; do not tune on it
```
`final_eval.py` and `exp10_prompting.py` import the frozen Python gate from `spike/egghead_gate.py` (the runtime is TypeScript now; `src/Gate.ts` is held to it by a parity test). Cached requests cost nothing. New ones go to the public API with concurrency 2 and a named User-Agent. Python 3.10+, standard library only.
