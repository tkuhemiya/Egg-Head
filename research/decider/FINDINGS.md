# Decider 2B experiments for Egg-Head (21 Oct 2026)

Model: `strands-decider-2b` via the free public API `https://api.decider.cloud/v1/systemone` (best effort).
Data: 273 incident-call lines (138 dev / 135 held-out) plus 24 correction sequences (12/12), **labelled by us, not by independent annotators**.
The data was frozen (sha256 in `data/FROZEN*.sha256`) before any model run. Everything was tuned on dev. The held-out split was scored **once**, with the choices recorded in `results/PREREGISTERED.json`.
Every number below comes from `results/*.json`. Small n: treat a gap of a few points as noise.

## Patterns so far (reusable rules for Decider)
1. **Ask yes/no questions, not N-way "what type is it" questions.** A 3-way choice (ask the agent / claim / other) got macro-F1 0.70. Two yes/no questions in one batch got 0.93. With 9 types, accuracy was 58%.
2. **Never trust a single choice ordering.** The top answer changed on 22–33% of items when we rotated the options. Averaging over all rotations raised check selection from 71% to 78% and the 3-way branch from 0.70 to 0.74 macro-F1. Better still, avoid the choice: one yes/no per option scored 86% vs 77% on the 3-branch choice.
3. **Send only the latest line, not the transcript.** Mean AUC for "is this a claim" was 0.91 with window 1, 0.80 with 3 and 0.77 with 6. Use code to resolve references, and add context only where it's needed (resource lookup used 3 turns).
4. **Wording matters more than anything else, and examples in the prompt hurt.** For "is it addressed to the agent?", the short wording got AUC 1.00 in the tagged format, where the AI is named in the header, but 0.50 on a raw transcript. The explicit wording got 1.00 in every format. Adding examples dropped claim AUC from 0.96 to 0.89.
5. **Raw yes-probabilities rank well but are badly calibrated. Recalibrate on dev, then threshold.** Raw outputs sat in a narrow 0.2–0.8 band (ECE 0.24–0.59). Platt scaling on dev brought ECE to 0.02–0.09. "Finished turn?" had F1 0.00 at 0.5 raw and 0.96 after Platt.
6. **Batching is free.** A batch of 1 vs 8 questions gave answers within 0.002 of each other on average (1 flip in 420), with p50 latency of 46 ms for 1 question and 93 ms for 8.
7. **Put code first.** Code finds the resource by alias, then Decider picks the check from that resource's short list. This was routing F1 0.74 vs 0.55 for one big check×resource choice.
8. **Persistence beats reacting at once (Jarvis).** Waiting until the claim had gone 3 turns uncorrected took false interrupts from 9/12 to 0/12. Waiting 2 turns cut them to 3/12.
9. **Decider and rules work together.** Wherever a keyword exists (agent's name, "hold on", a trailing "and"), a rule matches or beats Decider. Decider earns its place on things with no keyword ("is this a claim?" scored F1 0.85 vs 0.64 for the regex on held-out) and on combining signals in the speak gate.
10. **Don't do sequential trees when one batch gives the same answer.** The staged addressee→claim tree had identical accuracy to asking both at once, but needed 1.9 calls instead of 1.

## Headline held-out results (n=135 lines, 18 gate cases, 12 sequences; run once)
| Task | Decider pipeline | Best rule baseline |
|---|---|---|
| Is it a claim? | P 0.90 R 0.81 **F1 0.85** | keyword regex F1 0.64 |
| Addressed to Egg Head? | F1 0.86 (R 0.75) | name keyword F1 1.00 (our data always names the bot) |
| Claim → right check+resource | P **0.95** R 0.56 F1 0.70 (21 fired) | keyword route P 0.69 R 0.75 F1 0.72 |
| Speak gate (speak or stay quiet) | **F1 0.83**, 3 false interrupts, 1 miss | silence≥1.5 s F1 0.78 (0 FI, 4 missed); always speak F1 0.76 (7 FI) |
| Persistence (12 sequences) | 12/12 correct at persist=3 | keyword persist=3 also 12/12; speaking at once 3/12 |
| Cost | 3.16 requests per line, stage-1 p50 90 ms | — |
| LLM on every line | see the LLM baseline section below | |

Read it honestly: Decider clearly beats rules on claim detection and on the speak gate. Routing is high-precision but low-recall (it stays quiet when unsure, which is what you want before interrupting a call), and its F1 ties the keyword router. The addressee and persistence sets are too easy, since rules already score perfectly. We need harder, more naturally worded data before quoting those numbers.

## Experiments (dev split unless noted)

### Exp 1: Prompt wording × state format × context window (`exp1_dev.json`)
- **Hypothesis:** semantic turn detectors work on the latest utterance, so more context might help or might add noise.
- **Setup:** 3 wordings (repo / short / with examples) × 3 formats (raw / tagged / key-value) × windows 1, 3, 6, on the claim, addressee and finished-turn questions. Batch p50 latency 101 ms.
- **Results:** best claim was short wording, kv, w1: AUC 0.963, F1 0.90. Mean claim AUC fell from 0.91 (w1) to 0.80 (w3) to 0.77 (w6). Addressee with the repo wording got AUC 1.00 in all formats. The short wording got 1.00 when tagged but 0.48–0.50 raw. With examples, claim AUC was 0.89 vs 0.96. Finished-turn AUC was 0.95, but F1 at 0.5 was 0.00 because every probability was below 0.5.
- **Pattern:** 3, 4, 5.

### Exp 2: Option-order bias (`exp2_dev_summary.json`)
- **Hypothesis:** small models favour options in early positions, and rotating plus averaging cancels it.
- **Setup:** utterance type (9-way, with and without definitions), check selection and asserted state, each asked in every rotation.
- **Results:** top answer flips across rotations were 28% for type, 33% for check and 9% for asserted state. Mean probability on position 1 was 0.129 vs about 0.10 for the later positions. Check selection accuracy was 71% canonical, 76% two orders and 78% all rotations. 9-way type accuracy was 58% with definitions vs 30% bare. One yes/no per option got 61%, and a staged yes/no tree 54%.
- **Pattern:** 2.

### Exp 3: First branch, ask-the-agent vs claim vs other (`exp3_dev.json`)
- **Hypothesis (Themiya's idea):** branch first on "request to the agent or claim?". The question is how to ask it.
- **Setup:** 138 dev lines (16 requests, 45 claims, 77 other).
- **Results:**
  | Variant | Acc | Macro-F1 | F1 request | Calls | p50 ms |
  |---|---|---|---|---|---|
  | 3-way choice | 0.72 | 0.70 | 0.52 | 1 | 47 |
  | 3-way choice, 3 rotations averaged | 0.76 | 0.74 | 0.57 | 3 | 140 |
  | **two yes/no in one batch** (addr first, then claim) | **0.93** | **0.93** | 0.93 | 1 | 90 |
  | staged tree (ask claim only if not addr) | 0.93 | 0.93 | 0.93 | 1.9 | 92 |
  The best dev thresholds (addr 0.4, claim 0.5) gave macro-F1 0.94. As a claim signal, the `score` type (3 levels, expected value) got AUC 0.977 vs 0.962 for yes/no, which is a small gain worth retesting.
- **Conclusion:** the branch idea works when it's asked as separate yes/no questions in one batch, with priority applied in code.
- **Pattern:** 1, 10.

### Exp 4: Claim routing (`exp4_dev.json`, 41 gold routes)
- **Results:** R1, one check×resource choice: best F1 0.55 (P 0.81 R 0.41). R2, separate check and resource choices in one batch: F1 0.65. R3, resource then a restricted check: F1 0.72 (P 0.92). R4, code alias pre-pass, then Decider, then a restricted check: **F1 0.74 (P 0.90 R 0.63)**. Code alone settled the resource on 46 of 138 lines.
- **Pattern:** 7.

### Exp 5: Self-ensembles, paraphrase K=3/5, mean vs vote (`exp5_dev.json`; source: Bylaw "many typed questions")
- **Results:** claim: best single AUC 0.966. Mean of K=3 got AUC 0.979, best F1 0.92 vs 0.91. Voting gave the lowest ECE (0.070 vs 0.237 for a single question). Single paraphrases ranged from F1@0.5 0.00 to 0.90. Addressee was already AUC 1.00.
- **Conclusion:** paraphrase ensembles give a small ranking gain and better calibration through voting, but cost K times as much. Choosing the wording and recalibrating gives most of the gain.

### Exp 6: Calibration and confidence bands (`exp6_dev.json`, `exp6_platt_dev.json`; source: SlopGate bands)
- **Results:** ECE raw vs Platt: claim 0.237 vs 0.051, addressee 0.294 vs 0.017, finished-turn 0.587 vs 0.091. An abstain band of ±0.2 around 0.5 for claims kept 93.5% of lines with accuracy 0.946 vs 0.942, so there was little to gain on this data.
- **Pattern:** 5. Platt parameters are fit on dev and reused on held-out.

### Exp 7: Turn-taking, end of turn, interruption, addressee, persistence (`exp7_dev.json`; sources: VAP / semantic turn detectors, Jarvis)
- **Results:** finished-turn on text only: AUC 0.948, best F1 0.98. Adding the pause to the text dropped AUC to 0.795. Rules: trailing word F1 0.98, pause≥0.5 s 0.95. The would-interrupt question was useless (AUC 0.57 text, 0.30 with pause). Correction detection (self-repair) best F1 0.89. Persistence: Decider correction detector persist 1/2/3 got 4/7/10 of 12 correct. Decider or keyword at persist 3 got 12/12.
- **Conclusion:** don't put numbers like the pause into the prompt. Keep timing in code and send the text to Decider. Don't ask "would I interrupt?" directly.

### Exp 8: Batching (`exp8_dev.json`)
- 420 answers. Mean |Δp| batch vs single was 0.0019 (max 0.0115) with 1 decision flip. Question order inside a batch made no difference. p50 latency: 46 ms for 1 question, 92 ms for 2, 93 ms for 4 and 93 ms for 8.

## Caveats
- The labels and transcripts were written by us. The addressee and persistence sets are too easy, since keyword rules already score perfectly.
- The API is a hosted preview whose answers differ slightly from a local run, so latencies are network round-trip plus server time.
- The LLM baseline ran through OpenRouter, not Bedrock. It is the same open-weights model Bedrock serves, but a different host, so latency on Bedrock will differ.

## Update 21 Oct (afternoon): LLM baseline and recall work

### LLM-on-every-line baseline (`scripts/llm_baseline.py`, `scripts/llm_gate.py`, `results/llm_baseline_heldout.json`, `results/llm_gate_*.json`)
- **Model:** NVIDIA Nemotron 3 Super 120B (12B active, reasoning on), `nvidia/nemotron-3-super-120b-a12b` on OpenRouter. The same model is on Bedrock as `nvidia.nemotron-super-3-120b`, so the baseline is the exact model the agent could call on Bedrock. Among the free OpenRouter models it is the only strong one that is also on Bedrock. Its `:free` endpoint returned 404 from the provider, so we used the paid endpoint ($0.30 / $2.40 per million tokens in/out; the whole run cost well under $1).
- **Setup:** one call per line, temperature 0, JSON answer. It sees more than Decider does: the last 6 turns, the full resource and check catalogues, which checks exist for each resource, and for gate items the flagged claim and the silence length. Same 135 held-out lines.
- **Speak gate, honest note:** in v1 the speak decision was folded into the per-line prompt and the model answered `speak: null` on 16 of 18 gate items (F1 0.17). That is a prompt problem, not the model's ability, so we wrote a dedicated gate prompt (v2) after seeing that result, checked it on dev (F1 0.76), then ran it once on held-out. v2 is the number we report.

| Held-out | Decider pipeline (frozen) | Decider + exp 9 | Nemotron 3 Super 120B |
|---|---|---|---|
| Is it a claim? | P 0.90 R 0.81 F1 0.85 | P 0.88 R 0.90 F1 0.89 | P 0.93 R 0.98 **F1 0.95** |
| Addressed to Egg Head? | F1 0.86 | (unchanged) | F1 1.00 (the keyword rule also gets 1.00) |
| Claim → check + resource | P 0.95 R 0.56 F1 0.70 | P 0.81 R 0.81 F1 0.81 | P 0.83 R 0.97 **F1 0.90** |
| Speak gate (18) | F1 0.83, 3 false interrupts, 1 miss | (unchanged) | F1 0.88, 3 false interrupts, 0 misses |
| Latency per line | stage 1 p50 90 ms; about 3 calls per line | +0 calls (4 questions in the same batch) | p50 5.6 s, p95 19.4 s (gate prompt p50 2.6 s) |
| Cost per line | free preview; tiny 2B model | same | about 700 tokens in, 340 out, about $0.001 |

**Read it honestly.** The 120B reasoning model is more accurate on every task, by 4–9 F1 points. Decider is about 60× faster at the median and 200× at p95. For turn-taking that is the whole point: Jarvis waits about 2 s of silence and backs off within 0.5 s, and an LLM that takes 5–19 s answers after the moment has gone. The pitch is therefore not "Decider is smarter". It is "Decider makes the per-line call inside the turn-taking window at a fraction of the cost, and loses a few points to a model 60× its size". An untested next step is a cascade: Decider on every line, the LLM only on the few lines Decider flags, which is where the LLM's extra accuracy would be cheap.

### Exp 9: claim and routing recall (`scripts/exp9_recall.py`, `results/exp9_*.json`, `results/PREREGISTERED_exp9.json`)
- **Hypothesis:** routing recall of 0.56 comes from (a) the claim detector missing lines and (b) the route gate being too strict.
- **Setup:** 6 yes/no questions in one batch on the latest line (the old `short` wording, the `repo` wording, "says how something is right now as fact", "mentions a specific system", "reports a status or number", and an inverted "hedging, asking or planning" question). We combined their logits with a small logistic regression fit on dev (scored with leave-one-out on dev), and grid-searched the route gate on dev. The choice was frozen in `PREREGISTERED_exp9.json` and run once on held-out.
- **Dev:** single-question AUC: short 0.96, status 0.95, fact 0.94, names 0.92, hedge 0.15 (useful when inverted). Combo short+fact+status−hedge, leave-one-out F1 0.94 vs 0.91 for short alone. The route gate is where most of the recall went. The old pipeline needed min(claim, resource, check confidence) ≥ 0.5. Lowering it to 0.25 took dev routing from P 1.00 R 0.59 F1 0.74 to P 0.91 R 0.73 F1 0.81.
- **Held-out (run once):**
  - Claim: F1 0.85 → 0.89, recall 0.81 → 0.90, precision 0.90 → 0.88.
  - Routing with the gate change only: P 0.84 R 0.75 F1 0.79.
  - Routing with the gate change plus the claim combo: P 0.81 R 0.81 F1 0.81. That beats the keyword router (0.72) and the frozen pipeline (0.70).
  - Re-running the old setting reproduces the frozen numbers exactly (P 0.952 R 0.556), so nothing in the harness drifted.
- **What helped:** the looser route threshold (most of the gain) and the narrow-question combo (+4 claim F1, +0.06 routing recall). Both come at the cost of precision: routing P fell from 0.95 to 0.81, so 7 of 36 fired checks are wrong (the check runs, but Egg Head only speaks if the result contradicts the claim and the gate allows it).
- **What didn't:** the "mentions a system" question on its own (held-out AUC 0.83). Adding all 6 questions did no better than 4. The dev gains shrank on held-out (claim combo dev F1 0.94 vs held-out 0.89), the usual overfitting on n≈45 positives.
- **Pattern 11:** spend the threshold, not the model. When a calibrated pipeline is high-precision and low-recall, first look at how its confidences are combined: a min() over three stages compounds. Then add narrow yes/no questions to the same batch, which costs no extra latency (exp 8).

## Update 21 Oct (evening): prompt-engineering techniques (exp 10 Decider, exp 11 LLM)
Tuned on dev; choices frozen in `results/PREREGISTERED_exp10_11.json`; held-out run once. Scripts: `scripts/exp10_prompting.py`, `scripts/exp11_llm.py`. Results: `results/exp10_{dev,heldout}.json`, `results/exp11_{dev,heldout}.json`.

### Sources
- Zhao et al. 2021, *Calibrate Before Use* (contextual calibration with content-free inputs like "N/A"); revisited in Reif & Schwartz 2024, *Beyond Performance: Quantifying and Mitigating Label Bias in LLMs* (arxiv 2405.02743).
- Li et al. 2025, *CalibraEval* (ACL 2025): position and option-ID bias, swapping options and calibrating.
- Guan et al. 2025, *The Order Effect* (arxiv 2502.04134): shuffling inputs lowers accuracy, and few-shot only partly helps. This matches our exp 2 and exp 1 (examples hurt).
- Sclar et al. 2024 (ICLR), *Quantifying LMs' sensitivity to spurious features in prompt design*: small wording and format changes swing accuracy, so report across paraphrases.
- Tam et al. 2024 (EMNLP Industry), *Let Me Speak Freely?* (arxiv 2408.02442): JSON constraints can hurt reasoning, and key order matters (answer before reason means no reasoning). Classification often benefits from structured output. 2025 follow-ups (JSONSchemaBench, arxiv 2501.10868; the causal study arxiv 2509.21791) find little or no harm.
- Wang et al. 2023 (ICLR), *Self-Consistency*: sample several reasoning paths and vote.
- Liu et al. 2024/25, *Mind Your Step (by Step)*, and Anthropic 2025, *Inverse Scaling in Test-Time Compute*: more reasoning can hurt on some tasks, which is the reason to test reasoning budget.

### Decider (exp 10). Held-out numbers are AUC unless noted; dev in brackets
| Technique | Claim AUC held-out [dev] | Verdict |
|---|---|---|
| Baseline `short` wording | 0.954 [0.962] | reference |
| Definition in the question ("A claim is ... Does it make a claim?") | 0.894 [0.927] | **hurts** (−6 points), raw F1@0.5 falls to 0.54 |
| Contrastive ("as fact ..., rather than guessing, asking, planning, or the past") | 0.964 [0.951] | noise (mixed sign across splits) |
| Persona prefix ("You are a senior SRE") | 0.963 [0.969] | noise; not worth tokens |
| Negated question alone | 0.048 → inverted 0.952 [0.928] | ranks fine when flipped, but the yes-rate shifts, so it needs its own calibration |
| Negation pair (average of question and flipped negation) | 0.967 [0.962] | tiny gain, 2× questions (free in a batch) |
| Paraphrase ensemble (short+defn+contrast) | 0.956 [0.958] | no gain; the exp 5 result (+0.013) did not repeat |
| Contextual calibration (content-free prior) | AUC unchanged; F1@0.5 0.87 → 0.63 held-out | **hurts.** Content-free inputs give a low prior (logit about −1), so subtracting it pushes everything to "yes". Platt on labelled dev (exp 6) is much better |

- **Check option wording** (accuracy picking the right check given the right resource): the current *descriptions of what the check measures* scored held-out 0.89 [dev 0.73]. *Claim-shaped* options ("Claims that a database is fine, slow...") scored 0.64 [0.63] and bare names 0.72 [0.66]. Describe what the option **is**, not what inputs look like.
- **Gate repair question:** the contrastive wording raised repair AUC to 0.84 vs 0.70 on held-out and gate F1 to 0.87 vs 0.83, but it was *worse* on dev (F1 0.62 vs 0.71). It was not chosen, and with 18 items we treat it as noise. The negated wording ("did everyone accept it?") made the gate never speak (F1 0): the probabilities shift when the question is negated, so a fixed threshold breaks.
- **Pattern 12:** for this 2B model, the wording found in exp 1 already sits near the ceiling. The techniques that help large LLMs (definitions, personas, contextual calibration) do nothing or hurt. Keep questions short and plain, describe options by what they are, and recalibrate with labels (Platt), not with content-free priors.

### LLM baseline (exp 11, Nemotron 3 Super 120B, 117 non-gate lines)
| Config | Dev claim F1 / route F1 | Held-out claim F1 / route F1 | p50 / p95 latency | Out tokens | $ per 1k lines |
|---|---|---|---|---|---|
| v1 prompt, default reasoning | 0.964 / 0.935 | **0.975 / 0.932** | 5.6 s / 18.0 s | 339 | about $1.0 |
| v1, reasoning low | 0.965 / 0.937 | — | 6.3 s / 15.3 s | 326 | about $0.9 |
| v1, reasoning none | 0.920 / 0.923 | — | 1.4 s / 3.7 s | 39 | about $0.3 |
| rubric prompt, default reasoning | 0.963 / 0.946 (12 parse fails) | — | 4.1 s / 12.3 s | 305 | about $0.8 |
| **rubric prompt, reasoning none** (preregistered fast LLM) | 0.952 / 0.935 | **0.976 / 0.946** | **1.2 s / 3.0 s** | 39 | about $0.35 |
| "why" field first, reasoning none | 0.941 / 0.935 | — | 2.0 s / 5.4 s | 73 | about $0.4 |
| self-consistency k=3 | not measured: OpenRouter returned HTTP 402 on many calls | | | | |

- **Reasoning budget:** turning reasoning off cost about 4 claim-F1 points with the plain prompt. An explicit **rubric** recovered them, and the rubric with no reasoning matched or beat full reasoning on held-out at about 1/4 of the latency and cost. This fits "Mind Your Step": for this classification, explicit decision rules in the prompt beat thinking tokens.
- **Reason-before-answer key order** (Let Me Speak Freely) did not help once reasoning was off (0.941 vs 0.952 on dev).
- **Structured output:** plain "JSON only" instructions parsed fine except rubric+reasoning (12/124 dev parse failures, the model ran long). The 402 failures in the first held-out pass were retried and all 117 lines returned.

### Final held-out comparison (claim F1 / route F1, latency per line)
| System | Claim F1 | Route F1 | Latency |
|---|---|---|---|
| Decider pipeline, frozen (first PREREGISTERED) | 0.85 | 0.70 | about 3 calls, stage-1 p50 90 ms |
| Decider + exp 9 (still the best Decider setup after exp 10) | 0.89 | 0.81 | same batch, p50 about 90 ms |
| Nemotron 120B, rubric, no reasoning | 0.98 | 0.95 | p50 1.2 s, p95 3.0 s |
| Nemotron 120B, default reasoning | 0.98 | 0.93 | p50 5.6 s, p95 18 s |
(The LLM rows use the 117 non-gate lines and the Decider rows all 135. The gate items are mostly non-claims, so the difference is small but real.)

**Honest read:** with a good rubric and no reasoning, the 120B LLM is about 9 claim points and 14 routing points better than Decider, at about 13× the median latency (1.2 s vs 0.09 s) and real per-token cost. A 1.2 s p50 with a 3 s p95 still misses the turn-taking window (Jarvis: 2 s silence, back off within 0.5 s) on a fair share of lines. Decider's case rests on latency, cost and calibrated confidence, not on accuracy. The cascade (Decider on every line, LLM only on flagged lines) is the obvious next test.

### Spend
About $0.18 of OpenRouter usage in total for exp 11 plus the first baseline. The account reports **0 purchased credits**, which is why calls started failing with HTTP 402. More LLM runs need credits added.
