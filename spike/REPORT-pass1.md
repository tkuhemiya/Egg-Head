# Spike report: Decider go/no-go

- Model: `StrandsAgents/strands-decider-2B-qwen3.5-v1-2610`
- Run: 2026-10-17 00:47:44 +0000
- Snippets: 46 (16 with an open flagged claim)
- Backend: `{"backend": "local", "checkpoint": "StrandsAgents/strands-decider-2B-qwen3.5-v1-2610", "device": "cpu", "torch": "2.14.1+cu130", "gpu": null}`
- Client hardware: `{"platform": "Linux-6.12.94+-x86_64-with-glibc2.39", "machine": "x86_64", "processor": "x86_64", "python": "3.12.3", "cpus": 4}`
- Hardware note: cloud: 4 vCPU x86_64, 15 GB RAM, no GPU

## 1. Per-question accuracy

Confidence: noul = max(p, 1−p); choice = (N·p_max−1)/(N−1); score = the ordinal confidence the server returns. `silence_cost` counts as correct only on the exact level.

| question | n | accuracy | tricky acc | acc @ conf ≥ 0.9 | coverage @ 0.9 |
|---|---|---|---|---|---|
| `is_claim` | 46 | 63% | 69% | — | 0% |
| `which_check` | 37 | 59% | 38% | 44% | 24% |
| `which_resource` | 37 | 51% | 31% | 100% | 3% |
| `asserted_state` | 25 | 84% | 78% | — | 0% |
| `open_question` | 46 | 87% | 88% | — | 0% |
| `floor_free` | 46 | 26% | 31% | — | 0% |
| `self_repaired` | 16 | 75% | 83% | — | 0% |
| `silence_cost` | 16 | 0% | 0% | — | 0% |

## 2. Calibration (all questions pooled)

| P(predicted) | n | mean P | accuracy |
|---|---|---|---|
| 0.00–0.50 | 39 | 0.32 | 26% |
| 0.50–0.60 | 80 | 0.56 | 62% |
| 0.60–0.70 | 81 | 0.64 | 57% |
| 0.70–0.80 | 28 | 0.74 | 68% |
| 0.80–0.90 | 28 | 0.86 | 79% |
| 0.90–0.95 | 11 | 0.92 | 55% |
| 0.95–1.00 | 2 | 0.96 | 100% |

Expected calibration error (pooled, 269 answers): **0.083**

## 3. Check routing gate (§5.3 'run check')

- Fired on 0 of 46 snippets; 21 snippets hold a checkable claim.
- Precision (fired with the right check and resource): **—** (0/0)
- Recall over checkable claims: **0%** (0/21)
- Verdict (supports / contradicts / inconclusive) matches gold on 0/0 fired checks
- Wrong fires: none

## 4. Speak gate (§5.3 'speak', snippets with an open flagged claim)

- Precision **—**, recall **0%** (TP 0, FP 0, FN 8, n 16)

| id | gold | gate | self_repaired | floor_free | silence s | E[silence_cost] |
|---|---|---|---|---|---|---|
| s01 ❌ | speak | quiet | 0.35 | 0.47 | 1.6 | 1.82 |
| s02 | quiet | quiet | 0.62 | 0.58 | 0.8 | 1.99 |
| s03 | quiet | quiet | 0.51 | 0.51 | 0.1 | 1.99 |
| s04 ❌ | speak | quiet | 0.56 | 0.62 | 2.0 | 1.74 |
| s05 | quiet | quiet | 0.71 | 0.58 | 1.0 | 1.84 |
| s06 ❌ | speak | quiet | 0.36 | 0.41 | 1.4 | 1.46 |
| s07 | quiet | quiet | 0.45 | 0.48 | 1.5 | 1.60 |
| s08 ❌ | speak | quiet | 0.38 | 0.50 | 1.3 | 1.71 |
| s09 | quiet | quiet | 0.57 | 0.53 | 0.9 | 1.95 |
| s10 | quiet | quiet | 0.52 | 0.57 | 0.6 | 1.99 |
| s11 ❌ | speak | quiet | 0.41 | 0.47 | 3.0 | 1.91 |
| s12 ❌ | speak | quiet | 0.40 | 0.55 | 2.0 | 1.73 |
| s13 | quiet | quiet | 0.74 | 0.53 | 1.0 | 1.83 |
| s14 ❌ | speak | quiet | 0.63 | 0.51 | 1.0 | 1.76 |
| s15 | quiet | quiet | 0.59 | 0.52 | 0.4 | 1.78 |
| s16 ❌ | speak | quiet | 0.41 | 0.56 | 1.5 | 1.88 |

## 5. Latency (one batch of all questions per snippet)

- p50 **9174 ms**, p95 **10539 ms**, max 10933 ms over 46 snippets (8 questions each)
- State read once? On 5 snippets: batch 9325 ms vs 8511 ms for the same questions asked one by one (0.9×); input tokens 941 vs 1452.
- Latency only counts on the target machine; re-measure on the M4 if this ran elsewhere.

## 6. Rewording test

| question | n | accuracy | tricky acc | acc @ conf ≥ 0.9 | coverage @ 0.9 |
|---|---|---|---|---|---|
| `floor_free (base)` | 46 | 26% | 31% | — | 0% |
| `which_resource (base)` | 37 | 51% | 31% | 100% | 3% |
| `silence_cost (base)` | 16 | 0% | 0% | — | 0% |
| `floor_free@v0` | 46 | 74% | 75% | — | 0% |
| `floor_free@v1` | 46 | 87% | 81% | — | 0% |
| `which_resource@v0` | 37 | 51% | 31% | 100% | 8% |
| `which_resource@v1` | 37 | 51% | 31% | 100% | 5% |
| `silence_cost@v0` | 16 | 0% | 0% | — | 0% |

Variant wording: see `questions.VARIANTS`.

## 7. Errors

| question | id | gold | predicted | conf |
|---|---|---|---|---|
| `is_claim` | r07 | True | False | 0.52 |
| `is_claim` | r15 | False | True | 0.50 |
| `is_claim` | r16 | False | True | 0.60 |
| `is_claim` | r17 | False | True | 0.65 |
| `is_claim` | r19 | False | True | 0.65 |
| `is_claim` | r20 | False | True | 0.71 |
| `is_claim` | r22 | False | True | 0.56 |
| `is_claim` | r24 | True | False | 0.72 |
| `is_claim` | s03 | False | True | 0.53 |
| `is_claim` | s04 | False | True | 0.50 |
| `is_claim` | s05 | False | True | 0.65 |
| `is_claim` | s06 | False | True | 0.50 |
| `is_claim` | s08 | False | True | 0.54 |
| `is_claim` | s09 | True | False | 0.54 |
| `is_claim` | s10 | False | True | 0.63 |
| `is_claim` | s12 | True | False | 0.82 |
| `is_claim` | s14 | False | True | 0.54 |
| `which_check` | r02 | db_health | service_error_rate | 0.69 |
| `which_check` | r20 | none | recent_deploys | 0.26 |
| `which_check` | r24 | queue_depth | none | 0.61 |
| `which_check` | r27 | db_health | none | 0.48 |
| `which_check` | r29 | service_error_rate | none | 0.53 |
| `which_check` | r30 | service_error_rate | none | 0.43 |
| `which_check` | s01 | none | db_health | 0.73 |
| `which_check` | s04 | none | recent_deploys | 0.92 |
| `which_check` | s06 | none | queue_depth | 0.92 |
| `which_check` | s07 | none | service_error_rate | 0.72 |
| `which_check` | s08 | none | service_error_rate | 0.91 |
| `which_check` | s11 | none | db_health | 0.76 |
| `which_check` | s14 | none | recent_deploys | 0.93 |
| `which_check` | s15 | none | recent_deploys | 0.93 |
| `which_check` | s16 | none | db_health | 0.73 |
| `which_resource` | r02 | orders-db | orders-api | 0.81 |
| `which_resource` | r19 | unknown | orders-api | 0.41 |
| `which_resource` | r20 | unknown | orders-api | 0.88 |
| `which_resource` | r21 | unknown | orders-api | 0.24 |
| `which_resource` | r26 | unknown | orders-api | 0.30 |
| `which_resource` | r28 | unknown | orders-api | 0.35 |
| `which_resource` | r29 | unknown | orders-api | 0.35 |
| `which_resource` | r30 | payments-api | payments-db | 0.19 |
| `which_resource` | s01 | unknown | orders-api | 0.39 |
| `which_resource` | s04 | unknown | orders-api | 0.69 |
| `which_resource` | s06 | unknown | checkout-queue | 0.83 |
| `which_resource` | s07 | unknown | orders-api | 0.30 |
| `which_resource` | s08 | unknown | orders-api | 0.85 |
| `which_resource` | s11 | unknown | orders-api | 0.58 |
| `which_resource` | s12 | unknown | orders-db | 0.24 |
| `which_resource` | s14 | unknown | orders-api | 0.83 |
| `which_resource` | s15 | unknown | orders-api | 0.70 |
| `which_resource` | s16 | unknown | orders-api | 0.45 |
| `asserted_state` | r23 | healthy | unclear | 0.27 |
| `asserted_state` | r24 | healthy | unclear | 0.34 |
| `asserted_state` | r30 | healthy | unclear | 0.53 |
| `asserted_state` | s13 | degraded | healthy | 0.24 |
| `open_question` | r19 | True | False | 0.67 |
| `open_question` | r24 | False | True | 0.54 |
| `open_question` | s05 | True | False | 0.54 |
| `open_question` | s08 | True | False | 0.70 |
| `open_question` | s10 | True | False | 0.53 |
| `open_question` | s14 | False | True | 0.50 |
| `floor_free` | r01 | True | False | 0.68 |
| `floor_free` | r02 | True | False | 0.67 |
| `floor_free` | r03 | True | False | 0.62 |
| `floor_free` | r04 | True | False | 0.64 |
| `floor_free` | r05 | True | False | 0.58 |
| `floor_free` | r06 | True | False | 0.66 |
| `floor_free` | r07 | True | False | 0.64 |
| `floor_free` | r08 | True | False | 0.68 |
| `floor_free` | r09 | True | False | 0.66 |
| `floor_free` | r10 | True | False | 0.67 |
| `floor_free` | r11 | True | False | 0.62 |
| `floor_free` | r12 | True | False | 0.59 |
| `floor_free` | r13 | True | False | 0.63 |
| `floor_free` | r14 | True | False | 0.70 |
| `floor_free` | r15 | True | False | 0.67 |
| `floor_free` | r16 | True | False | 0.63 |
| `floor_free` | r17 | True | False | 0.66 |
| `floor_free` | r18 | True | False | 0.65 |
| `floor_free` | r19 | True | False | 0.66 |
| `floor_free` | r20 | True | False | 0.67 |
| `floor_free` | r21 | True | False | 0.66 |
| `floor_free` | r22 | True | False | 0.58 |
| `floor_free` | r23 | True | False | 0.64 |
| `floor_free` | r26 | True | False | 0.61 |
| `floor_free` | r27 | True | False | 0.64 |
| `floor_free` | r28 | True | False | 0.64 |
| `floor_free` | r29 | True | False | 0.67 |
| `floor_free` | r30 | True | False | 0.65 |
| `floor_free` | s01 | True | False | 0.53 |
| `floor_free` | s03 | False | True | 0.51 |
| `floor_free` | s06 | True | False | 0.59 |
| `floor_free` | s07 | True | False | 0.52 |
| `floor_free` | s10 | False | True | 0.57 |
| `floor_free` | s15 | False | True | 0.52 |
| `self_repaired` | s03 | False | True | 0.51 |
| `self_repaired` | s04 | False | True | 0.56 |
| `self_repaired` | s14 | False | True | 0.63 |
| `self_repaired` | s15 | False | True | 0.59 |
| `silence_cost` | s01 | 3 | 2 | 0.38 |
| `silence_cost` | s02 | 3 | 2 | 0.37 |
| `silence_cost` | s03 | 3 | 2 | 0.36 |
| `silence_cost` | s04 | 4 | 2 | 0.38 |
| `silence_cost` | s05 | 4 | 2 | 0.37 |
| `silence_cost` | s06 | 3 | 1 | 0.39 |
| `silence_cost` | s07 | 1 | 2 | 0.38 |
| `silence_cost` | s08 | 4 | 2 | 0.38 |
| `silence_cost` | s09 | 4 | 2 | 0.38 |
| `silence_cost` | s10 | 3 | 2 | 0.38 |
| `silence_cost` | s11 | 3 | 2 | 0.37 |
| `silence_cost` | s12 | 3 | 2 | 0.37 |
| `silence_cost` | s13 | 3 | 2 | 0.36 |
| `silence_cost` | s14 | 4 | 2 | 0.37 |
| `silence_cost` | s15 | 4 | 2 | 0.37 |
| `silence_cost` | s16 | 3 | 2 | 0.38 |

## 8. Suggested verdict

**NO-GO** (rule: GO if every routing question is ≥ 90% accurate at confidence ≥ 0.9, routing-gate precision ≥ 90% and speak-gate precision ≥ 80%; NO-GO if any of the first two is below 75%; otherwise GO-with-changes). The final call, thresholds and wording are a human decision: record them in NextSteps.md.
