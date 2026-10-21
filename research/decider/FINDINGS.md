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
| LLM on every line | TODO: no Bedrock credentials on the box | |

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
- The LLM-on-every-line baseline has not run yet (no Bedrock credentials).
