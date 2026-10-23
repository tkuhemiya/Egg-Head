# Spike report: Decider go/no-go

**Human verdict: GO-with-changes.** See [README.md](README.md) for what was kept and what moved into code. Do not gate on conf ≥ 0.9 for these noul questions.

- Model: `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610`
- Run: 2026-10-17 01:18:23 +0000
- Snippets: 46 (16 with an open flagged claim)
- Backend: `{"backend": "local", "checkpoint": "StrandsAgents/strands-decider-2B-qwen3.5-v1-2610", "device": "cpu", "torch": "2.14.1+cu130", "gpu": null}`
- Client hardware: `{"platform": "Linux-6.12.94+-x86_64-with-glibc2.39", "machine": "x86_64", "processor": "x86_64", "python": "3.12.3", "cpus": 4}`
- Hardware note: cloud: 4 vCPU x86_64, 15 GB RAM, no GPU; pass 2 wording

## 1. Per-question accuracy

Confidence: noul = max(p, 1−p); choice = (N·p_max−1)/(N−1); score = the ordinal confidence the server returns. Pass-2 `silence_cost` is noul (gold = level ≥ moderate). Pass-2 `floor_free` is asked as 'would speaking interrupt?' and inverted.

| question | n | accuracy | tricky acc | acc @ conf ≥ 0.9 | coverage @ 0.9 |
|---|---|---|---|---|---|
| `is_claim` | 46 | 72% | 69% | — | 0% |
| `which_check` | 37 | 68% | 46% | — | 0% |
| `which_resource` | 37 | 62% | 38% | — | 0% |
| `asserted_state` | 25 | 56% | 33% | — | 0% |
| `open_question` | 46 | 87% | 88% | — | 0% |
| `floor_free` | 46 | 87% | 81% | — | 0% |
| `self_repaired` | 16 | 69% | 83% | — | 0% |
| `silence_cost` | 16 | 12% | 17% | — | 0% |

## 2. Calibration (all questions pooled)

| P(predicted) | n | mean P | accuracy |
|---|---|---|---|
| 0.00–0.50 | 21 | 0.39 | 52% |
| 0.50–0.60 | 63 | 0.55 | 40% |
| 0.60–0.70 | 58 | 0.65 | 64% |
| 0.70–0.80 | 65 | 0.74 | 88% |
| 0.80–0.90 | 60 | 0.84 | 93% |
| 0.90–0.95 | 2 | 0.90 | 100% |

Expected calibration error (pooled, 269 answers): **0.104**

## 3. Check routing gate (§5.3 'run check')

- Fired on 4 of 46 snippets; 21 snippets hold a checkable claim.
- Precision (fired with the right check and resource): **100%** (4/4)
- Recall over checkable claims: **19%** (4/21)
- Verdict (supports / contradicts / inconclusive) matches gold on 2/4 fired checks
- Wrong fires: none

## 4. Speak gate (§5.3 'speak', snippets with an open flagged claim)

- Precision **0%**, recall **0%** (TP 0, FP 1, FN 8, n 16)
- Thresholds: T_ROUTE=0.7, T_SELF_REPAIRED=0.45, T_FLOOR=0.5 (FLOOR_INVERT=True), T_SILENCE_S=1.2s, T_COST=0.5

| id | gold | gate | self_repaired | floor_free | silence s | silence_cost |
|---|---|---|---|---|---|---|
| s01 ❌ | speak | quiet | 0.26 | 0.78 | 1.6 | 0.38 |
| s02 ❌ | quiet | speak | 0.38 | 0.77 | 0.8 | 0.51 |
| s03 | quiet | quiet | 0.36 | 0.69 | 0.1 | 0.45 |
| s04 ❌ | speak | quiet | 0.27 | 0.82 | 2.0 | 0.46 |
| s05 | quiet | quiet | 0.31 | 0.82 | 1.0 | 0.49 |
| s06 ❌ | speak | quiet | 0.18 | 0.82 | 1.4 | 0.36 |
| s07 | quiet | quiet | 0.21 | 0.81 | 1.5 | 0.44 |
| s08 ❌ | speak | quiet | 0.19 | 0.83 | 1.3 | 0.41 |
| s09 | quiet | quiet | 0.27 | 0.81 | 0.9 | 0.36 |
| s10 | quiet | quiet | 0.31 | 0.78 | 0.6 | 0.46 |
| s11 ❌ | speak | quiet | 0.28 | 0.76 | 3.0 | 0.41 |
| s12 ❌ | speak | quiet | 0.25 | 0.81 | 2.0 | 0.42 |
| s13 | quiet | quiet | 0.35 | 0.85 | 1.0 | 0.50 |
| s14 ❌ | speak | quiet | 0.22 | 0.57 | 1.0 | 0.40 |
| s15 | quiet | quiet | 0.21 | 0.74 | 0.4 | 0.43 |
| s16 ❌ | speak | quiet | 0.34 | 0.82 | 1.5 | 0.43 |

## 5. Latency (one batch of all questions per snippet)

- p50 **12082 ms**, p95 **13886 ms**, max 14016 ms over 46 snippets (8 questions each)
- State read once? On 2 snippets: batch 9911 ms vs 9060 ms for the same questions asked one by one (0.9×); input tokens 1080 vs 1826.
- Latency only counts on the target machine; re-measure on the M4 if this ran elsewhere.

## 6. Rewording test

Not run yet. The Day-1 run harness (`run.py`) is in git history, not this folder.

## 7. Errors

| question | id | gold | predicted | conf |
|---|---|---|---|---|
| `is_claim` | r16 | False | True | 0.51 |
| `is_claim` | r17 | False | True | 0.55 |
| `is_claim` | r18 | False | True | 0.55 |
| `is_claim` | r19 | False | True | 0.67 |
| `is_claim` | r20 | False | True | 0.63 |
| `is_claim` | r24 | True | False | 0.63 |
| `is_claim` | s04 | False | True | 0.52 |
| `is_claim` | s05 | False | True | 0.53 |
| `is_claim` | s06 | False | True | 0.53 |
| `is_claim` | s07 | False | True | 0.63 |
| `is_claim` | s08 | False | True | 0.58 |
| `is_claim` | s10 | False | True | 0.51 |
| `is_claim` | s16 | False | True | 0.58 |
| `which_check` | r02 | db_health | service_error_rate | 0.49 |
| `which_check` | r08 | service_error_rate | none | 0.65 |
| `which_check` | r11 | recent_deploys | none | 0.50 |
| `which_check` | r12 | db_health | none | 0.44 |
| `which_check` | r24 | queue_depth | none | 0.71 |
| `which_check` | r26 | db_health | none | 0.43 |
| `which_check` | r27 | db_health | none | 0.59 |
| `which_check` | r28 | alarm_state | none | 0.48 |
| `which_check` | r29 | service_error_rate | none | 0.68 |
| `which_check` | r30 | service_error_rate | none | 0.49 |
| `which_check` | s02 | db_health | none | 0.28 |
| `which_check` | s12 | alarm_state | none | 0.51 |
| `which_resource` | r02 | orders-db | orders-api | 0.79 |
| `which_resource` | r20 | unknown | orders-api | 0.85 |
| `which_resource` | r27 | payments-db | unknown | 0.19 |
| `which_resource` | r28 | unknown | orders-api | 0.21 |
| `which_resource` | r29 | unknown | orders-api | 0.33 |
| `which_resource` | s01 | unknown | orders-api | 0.67 |
| `which_resource` | s06 | unknown | checkout-queue | 0.60 |
| `which_resource` | s07 | unknown | orders-api | 0.29 |
| `which_resource` | s08 | unknown | orders-api | 0.80 |
| `which_resource` | s11 | unknown | orders-api | 0.59 |
| `which_resource` | s12 | unknown | orders-api | 0.19 |
| `which_resource` | s14 | unknown | orders-api | 0.65 |
| `which_resource` | s15 | unknown | orders-api | 0.19 |
| `which_resource` | s16 | unknown | orders-api | 0.57 |
| `asserted_state` | r02 | healthy | unclear | 0.26 |
| `asserted_state` | r04 | healthy | unclear | 0.48 |
| `asserted_state` | r11 | changed | unclear | 0.44 |
| `asserted_state` | r14 | degraded | unclear | 0.45 |
| `asserted_state` | r23 | healthy | unclear | 0.46 |
| `asserted_state` | r24 | healthy | unclear | 0.41 |
| `asserted_state` | r28 | healthy | unclear | 0.43 |
| `asserted_state` | r29 | degraded | unclear | 0.40 |
| `asserted_state` | r30 | healthy | unclear | 0.44 |
| `asserted_state` | s12 | healthy | unclear | 0.32 |
| `asserted_state` | s13 | degraded | healthy | 0.27 |
| `open_question` | r18 | True | False | 0.65 |
| `open_question` | r19 | True | False | 0.64 |
| `open_question` | s05 | True | False | 0.58 |
| `open_question` | s08 | True | False | 0.83 |
| `open_question` | s10 | True | False | 0.55 |
| `open_question` | s15 | True | False | 0.58 |
| `floor_free` | r24 | False | True | 0.65 |
| `floor_free` | r25 | False | True | 0.55 |
| `floor_free` | s03 | False | True | 0.69 |
| `floor_free` | s10 | False | True | 0.78 |
| `floor_free` | s11 | False | True | 0.76 |
| `floor_free` | s15 | False | True | 0.74 |
| `self_repaired` | s02 | True | False | 0.62 |
| `self_repaired` | s05 | True | False | 0.69 |
| `self_repaired` | s09 | True | False | 0.73 |
| `self_repaired` | s10 | True | False | 0.69 |
| `self_repaired` | s13 | True | False | 0.65 |
| `silence_cost` | s01 | True | False | 0.62 |
| `silence_cost` | s03 | True | False | 0.55 |
| `silence_cost` | s04 | True | False | 0.54 |
| `silence_cost` | s05 | True | False | 0.51 |
| `silence_cost` | s06 | True | False | 0.64 |
| `silence_cost` | s08 | True | False | 0.59 |
| `silence_cost` | s09 | True | False | 0.64 |
| `silence_cost` | s10 | True | False | 0.54 |
| `silence_cost` | s11 | True | False | 0.59 |
| `silence_cost` | s12 | True | False | 0.58 |
| `silence_cost` | s13 | True | False | 0.50 |
| `silence_cost` | s14 | True | False | 0.60 |
| `silence_cost` | s15 | True | False | 0.57 |
| `silence_cost` | s16 | True | False | 0.57 |

## 8. Suggested verdict

**GO-with-changes** (rule: GO if every routing question is ≥ 90% accurate at confidence ≥ 0.9, routing-gate precision ≥ 90% and speak-gate precision ≥ 80%; NO-GO if any of the first two is below 75%; otherwise GO-with-changes). Pass 1 showed conf ≥ 0.9 is mostly empty on these noul questions, so the human call should also look at routing-gate precision at T_ROUTE and speak-gate precision. Record the call in NextSteps.md.
