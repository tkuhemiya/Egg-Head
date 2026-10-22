# Speak gate rework: re-score on pass-2 answers

> The new gate was written after reading these 16 snippets and the pass-2 errors. Read the score as a fit, not a held-out result.

- Pass-2 gate (questions.speak_gate): precision **0%**, recall **0%** (TP 0, FP 1, FN 8, n 16)
- Reworked gate (spike/egghead_gate.py): precision **100%**, recall **100%** (TP 8, FP 0, FN 0, n 16)

| id | gold | pass 2 | reworked | blocked by | repaired by | cost | P(gap) | silence s |
|---|---|---|---|---|---|---|---|---|
| s01 | speak | quiet | speak |  |  | high | 0.78 | 1.6 |
| s02 | quiet | speak | quiet | not_repaired | keyword | high | 0.77 | 0.8 |
| s03 | quiet | quiet | quiet | min_silence |  | high | 0.69 | 0.1 |
| s04 | speak | quiet | speak |  |  | high | 0.82 | 2.0 |
| s05 | quiet | quiet | quiet | not_repaired | keyword | high | 0.82 | 1.0 |
| s06 | speak | quiet | speak |  |  | high | 0.82 | 1.4 |
| s07 | quiet | quiet | quiet | worth_it |  | low | 0.81 | 1.5 |
| s08 | speak | quiet | speak |  |  | high | 0.83 | 1.3 |
| s09 | quiet | quiet | quiet | not_repaired | keyword | high | 0.81 | 0.9 |
| s10 | quiet | quiet | quiet | not_repaired | keyword | high | 0.78 | 0.6 |
| s11 | speak | quiet | speak |  |  | high | 0.76 | 3.0 |
| s12 | speak | quiet | speak |  |  | moderate | 0.81 | 2.0 |
| s13 | quiet | quiet | quiet | not_repaired | keyword | high | 0.85 | 1.0 |
| s14 | speak | quiet | speak |  |  | high | 0.57 | 1.0 |
| s15 | quiet | quiet | quiet | min_silence |  | high | 0.74 | 0.4 |
| s16 | speak | quiet | speak |  |  | high | 0.82 | 1.5 |
