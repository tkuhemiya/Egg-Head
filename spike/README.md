# Day-1 spike (history, frozen)

The go/no-go test from 17 Oct: does Decider 2B answer Egg Head's questions reliably? Pass 1 (the original wording, T_ROUTE=0.9) never fired; pass 2 (simpler wording, latest-line routing, T_ROUTE=0.7) gave **GO-with-changes** ([REPORT.md](REPORT.md)). The speak gate was then reworked in code and re-scored on the pass-2 answers ([REPORT-gate.md](REPORT-gate.md); a fit to those 16 snippets, not a held-out result). The research campaign in [`research/decider/`](../research/decider/FINDINGS.md) replaced this harness, and the TypeScript runtime replaced the gate.

What pass 2 decided:

| Decision | Owner after pass 2 |
|---|---|
| Run a check | Decider `is_claim` + `which_check` + `which_resource`, fire at 0.7 (precision 4/4, recall 19%); 0.55–0.7 escalates to Bedrock |
| Floor / interrupt | Decider, asked as "would speaking interrupt?" and inverted (87%), plus a minimum of VAD silence in code |
| Claim vs check | Code (`compare`); `asserted_state` fell to 56% |
| `silence_cost` | Code, from the check that disagreed (Decider 12%, always ~0.4) |
| `self_repaired` | Keywords and later true claims in code, Decider as a weak vote (69%) |

The research campaign later replaced the routing questions and the gate's Decider inputs (see `AGENTS.md`, "Router = research pipeline").

What is left is what the parity tests and research scripts still need:

| File | What |
|---|---|
| `egghead_gate.py` | The frozen Python speak gate. `src/Gate.ts` is held to it (`test/Parity.test.ts`); `research/decider/scripts/final_eval.py` and `exp10_prompting.py` import it. |
| `questions.py` | The pass-2 question set, gates and claim/check comparison. |
| `out/results.jsonl`, `out/meta.json` | The pass-2 Decider answers (local HF weights; `meta.json` records the backend). |
| `gate_eval.py` | Re-scores the gate on those answers and writes `REPORT-gate.md`. |
| `export_gate_parity.py` | Writes `test/fixtures/gate-parity.json` (the 16 pass-2 rows plus a 20k-point input grid). |

The labelled snippets are `research/decider/data/source/egghead_spike.jsonl` and the check world is `data/world.json`. The pass-1 archive, the run/eval harness and the never-scored held-out gate set are in git history.

```bash
python3 spike/gate_eval.py            # REPORT-gate.md (standard library only)
python3 spike/export_gate_parity.py   # regenerate the gate fixture after an intentional gate change
```
