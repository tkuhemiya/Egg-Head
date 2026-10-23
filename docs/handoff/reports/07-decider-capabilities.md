# Strands Decider: what it is good and bad at, and what our research says (for the Decider-on-state idea)

_A delegated report from 23 Oct 2026, kept as written. Line numbers are at the commit it names or at 7dd7885 (before this PR). Treat claims as findings, checked where docs/handoff/continue.md says so._

Research report: should Egg Head give Decider its program state and let it pick decisions?

Paths: D = strands-decider repo (github.com/strands-labs/strands-decider), F = /home/user/Egg-Head/research/decider/FINDINGS.md. Items marked (inferred) are my reading, not text from the repos.

## 1. What Decider is and is not

- **Design.** It is a "system one" decision model: it "picks between sets of options and rates things on a scale", with no text generation (D/README.md lines 26-31).
  - It is a Qwen3.5-2B torso (LM head removed) plus a roughly 1M-parameter pointer head and a rank-16 LoRA, with one forward pass and no decoding (D/docs/architecture.md "The core idea", lines ~34-70).
- **Question types.** Three, all the same masked softmax read back differently (D/docs/architecture.md, "One mechanism, three primitives", ~line 99).
  - `noul`: yes/no, returns P(true).
  - `choice`: N options, returns argmax, per-option probabilities, and a confidence of (N·p_max−1)/(N−1).
  - `score`: 2-10 ordered levels, returns expected value plus a confidence based on spread.
- **Option count.** There is no per-option parameter. Options come from the request and the schema ceiling is 255 (D/docs/architecture.md lines ~64-78; D/skills/customize-decider/SKILL.md Phase 0 says "2 to 255").
- **State format.**
  - `state` may be a string or JSON data. JSON is rendered as indented, deterministic JSON by `render_content` (D/src/strands_decider/prompting.py; D/docs/inference.md ~line 239; D/skills/customize-decider/references/data-format.md line 12).
  - Option descriptions can also be structured data. `state` may be empty if the question carries the whole task.
  - The rendered prompt is `<state>…</state><question>…<options>1. name — desc …</options></question><answer>` (D/docs/architecture.md lines 40-52).
  - I found no guidance that recommends JSON or key-value over prose, and no guidance on putting program or agent state into `state`.
  - The only agent-state precedent is the Strands example, where the state is the conversation plus a proposed tool call (D/examples/strands/README.md).
- **Context.**
  - The default window is 4096 tokens (D/evaluation/jevbench.md "The context window is not the ceiling"; D/docs/inference.md ~line 242). Over-long prompts have the state cut from the front and the question and options kept. `--strict-window` returns 422 instead.
  - Training rows are short: median 204 tokens, p99 634, max 1811 (D/training/hardware.md).
  - The model "reads the extra text and cannot use it" past ~3072 tokens. `long_policy` scores 0.368 with the whole document in context, barely above chance (jevbench.md lines 175-182).
- **Batching.** Many questions over one state are nearly free because of a shared-prefix cache.
  - 1 question took 219 ms and 6 took 217 ms on v7 (D/docs/inference.md "Asking many questions is nearly free").
  - On v14, 8 questions over ~2000 tokens took 369 ms vs 1964 ms unbatched.
  - Questions are scored independently and cannot see each other.
  - `--max-batch` defaults to 32.
- **Stated poor fits.** From D/skills/customize-decider/SKILL.md Phase 0, lines ~44-50:
  - Free-text answers.
  - Options not known before the call.
  - Decisions that need many reasoning steps not in the state.
  - A state much longer than the window.
- **Stated limits** (D/evaluation/README.md "Limitations"):
  - The model answers the same way to a changed question about 94% of the time, and "which does this NOT fit?" is often answered as if it were not negated.
  - Long multi-step documents are still the weak spot.
  - `noul` generalises poorly to genuinely novel yes/no tasks: 0.614 against a 0.500 baseline.
  - `score` is weak on rubrics unlike the training mix (0.617 in the mix, 0.499 unseen).

## 2. Agent-policy use cases in the repo

- **Stated targets** (D/README.md "What can I do with it?", lines ~365-374): model routing, tool selection, argument checking, triage, guardrails, evaluations, and "hybrid agents" where the LLM makes the hard decisions and the decider makes the rote ones.
- **Only worked example.** `examples/strands/` gates a `get_weather` call on two yes/no questions (are the arguments grounded in what the user said; is calling the tool now premature) and turns the probabilities into a decision with plain Python.
  - The README says it is "an illustration rather than a recommendation": the questions, thresholds and policy "were all picked by hand". No accuracy is reported.
- **Nothing on turn-taking or interruption.** I found no example or evaluation on turn-taking, interruption, silence or timing in D. Those findings exist only in Egg Head's own FINDINGS.md.
- **Accuracy on agent-like families.** From the v19 JevBench per-family table (D/evaluation/jevbench.md lines 86-98 and 123-130):
  - Strong: `tool_selection` 1.000, `routing_hard` 1.000, `intent` 0.917, `extraction`/`fact`/`ordinal` 1.000. These are all "match a state to a category" tasks, and the doc says so.
  - Middling: `policy` 0.75, `adversarial` 0.667, `judge_hard` 0.588 (a described action judged against a policy, with the answer turning on a condition or a withdrawn instruction).
  - Weak: `temporal_numeric` 0.267, `probability` 0.300, `long_policy` 0.368, `multi_hop` 0.444, `tradeoff` 0.500.
- v1 added "rule-application rows (apply a written policy to a case)", with 22,168 rows whose gold answers were computed by code (D/evaluation/results.md lines 14-20). I found no per-family number for them in the v1 section.

## 3. Evaluation numbers by task type

- **Overall.**
  - v1 (Qwen3.5-2B, the model Egg Head's hosted API likely resembles) scores 180/231 = 0.779 on JevBench public, Brier 0.280, ECE 0.072 (D/evaluation/results.md lines 43-58).
  - v19 scores 0.723 (167/231) and v21 0.762.
  - Seed SD is about 3 items. D/README.md says differences under ~10 tasks between single runs are unresolved.
  - Tiers for v1: easy 48/48, standard 67/72, hard 65/111 = 0.586 (results.md line 58 and README.md).
  - Leaders on hard score 0.96 (jevbench.md line 77) and are reasoning models (jevbench.md lines 36-38, 132-135).
- **Larger models.**
  - Gemma 4 E4B scores 187, 12B 200, and 26B-A4B 207 of 231 (README.md lines 225-232).
  - Hard tier for 12B is 81/111 and for 26B-A4B 87/111.
  - Scaling gains are almost all in the hard tier (jevbench.md lines 114-116).
- **In-mix vs unseen short classification** (v19; results.md lines 357-368):
  - `noul` 0.961 in the mix (v14) vs 0.596 on unseen tasks.
  - `choice` 0.960 vs 0.725.
  - `score` 0.617 vs 0.499.
  - Fine-tuning on your own task is what moves the first row.
- **Weak areas** (jevbench.md lines 132-147, README "Limitations"):
  - Arithmetic and time comparison: `temporal_numeric` 0.267 "looks capability-bound for a single-pass model". No non-reasoning system on the board passes 0.533, and training data on rule versions and running totals left it unchanged.
  - Counting and probability: `probability` 0.300.
  - Multi-step inference: `multi_hop` 0.444. Targeted training data moved this (0.333 to 0.500 with MuSiQue rows), but it is still weak.
  - Long state: flat past ~3072 tokens (see section 1).
  - Multi-hop on unseen sources: HotpotQA 0.726 (v19), 0.832 (v1).
- **Latency.** The median is 115 ms and p95 299 ms on an RTX 3090 (v19). Gemma 4 on one H100 is 102-245 ms (README.md lines 225-232).

## 4. Calibration and bias guidance

- **Option order.** Order sensitivity is "small but not zero". Reversing the list moves the distribution by ~0.016 because options still attend to earlier ones (D/docs/architecture.md lines 79-82). Training shuffles option order every epoch (architecture.md ~168).
  - Egg Head measured much more than that (see section 6).
- **Confidence bands.** Act at ≥0.9, confirm at 0.5-0.9, send to a person below 0.5 (architecture.md "The routing convention").
  - On unseen short classification, v19's ≥0.9 band is right 0.952 of the time and covers about 23% of answers. The 0.5-0.9 band is right 0.655 and <0.5 is right 0.474 (results.md ~lines 396-406).
  - The bands "hold only" on short classification. On long documents and adequacy judgements v19 is under-confident (right 0.83 at a stated 0.64), and "no single temperature per primitive serves both" (results.md ~416-427).
  - The docs say to fit the temperature on a sample of your own traffic (jevbench.md line 221-223; the SKILL.md Phase 3 `calibrate` step does this).
- **`noul` is the least well calibrated primitive.** ECE is 0.162 within bins (results.md ~line 440). It has no separate confidence field, so you threshold P(yes) directly. SKILL.md Phase 8 suggests two cut points, e.g. >0.8, 0.4-0.8, <0.4, chosen from error costs.
- **Wording.** Where the model is strong, wording does not matter (`massive_intent` spread 0.006). Where it is weak, wording dominates (`hate_severity` 0.355-0.504). "Try several phrasings… it is free and worth up to 0.15 on a hard task" (D/research/history.md ~lines 990-1012).
- **Ensembles.** I found no documented option-rotation or ensemble procedure. The only recommendation is to try several phrasings and calibrate. The SKILL.md uses a soup of 3 seeds for training, which is a different thing.

## 5. Customization

- **Yes, it can be fine-tuned on your own labelled data.** The path is `skills/customize-decider/` (D/skills/customize-decider/SKILL.md) plus `training/`.
  - The ladder in Phase 4 is: (1) reword, (2) recalibrate, (3) choose a larger released size, (4) fine-tune with `init_from` (LoRA plus head).
  - It says to stop at the first rung that meets your target, and that a larger base usually gains more than training a small one.
- **Data size.**
  - Fine-tuning "a few thousand rows per decision is a sensible start, and gains usually flatten in the tens of thousands".
  - The evaluation set should be ≥1000 test items per decision plus a similar number for calibration, with a time-cutoff split and grouping by conversation.
  - Add the public corpus to keep general skill and calibration.
  - Give each question 2-4 `instruction_variants`.
  - Do not reweight labels by default.
  - Row format: `{kind, state, instructions, options:[[name,desc]…], label, task}` (D/skills/customize-decider/references/data-format.md).
- **Hardware** (D/skills/customize-decider/references/training.md "Hosts"):

  | Torso | Peak memory | GPU that fits |
  |---|---|---|
  | Qwen3.5 2B | under 24 GiB | 24 GB (3090/4090/L4) |
  | Gemma E2B | 14.5 GiB | 24 GB |
  | Gemma E4B | 19.9 GiB | 48 GB (L40S) is safe |
  | Gemma 12B | 28.6 GiB | 48 GB or 80 GB |
  | Gemma 26B-A4B | 52.9 GiB | 80 GB |

  - Full v19 recipe: about 11 h on one 3090, or 1 h 10 min on eight H100s (README.md "Training"). A fine-tune on a few thousand rows would be far shorter; I found no stated time for it (inferred).
  - Three seeds are recommended, then a soup, then `calibrate` (SKILL.md Phases 6-7).
  - I found no dollar figure; the skill defers to the user for host price.
- **Caveat on fine-tuning.** Smaller models "gain more from training than larger ones". Training on in-distribution data is what lifts `noul` from 0.60 to 0.96, so a labelled Egg Head state-decision set is the lever (inferred application). The skill asks for human-audited labels, and Egg Head's own labels are self-written (F line 4).

## 6. Egg Head's own findings that bear on the idea

All from F. n is small, and labels were written by the team.

- **Prefer yes/no over N-way choice** (F lines 9, 47-59).
  - 3-way choice macro-F1 0.70 vs 0.93 for two yes/no questions in one batch.
  - 9-way type accuracy is 58% with definitions and 30% bare.
  - One yes/no per option got 86% vs 77% on the 3-branch choice.
  - Routing as one check×resource choice gives F1 0.55; code finds the resource first, then Decider picks the check, F1 0.74 (exp 4).
  - So "flag / answer / ack / stay quiet" as one 4-way choice is in the weak regime (inferred).
- **Option-order bias is much bigger than documented.** The top answer flipped on 28% (type), 33% (check) and 9% (asserted state) of items under rotation. Averaging all rotations took check accuracy from 71% to 78% (F line 44). The repo's ~0.016 shift (section 4) is about a different quantity; the two are not directly comparable.
- **Context window.** For claim detection, AUC was 0.91 with window 1, 0.80 with 3 and 0.77 with 6. Send only the latest line and resolve references in code (F lines 11, 38). Extra state demonstrably dilutes a 2B model's judgement here.
- **Timing in the prompt hurts.** Finished-turn AUC was 0.948 on text only and fell to 0.795 when the pause was added. "Would I interrupt?" was useless (AUC 0.57 on text, 0.30 with pause). Keep timing in code (F line 74).
- **Pre-campaign spike results** (F-adjacent: /home/user/Egg-Head/spike/REPORT.md lines 21-25 and /home/user/Egg-Head/src/Gate.ts lines 3-15):
  - `floor_free`, asked as "would speaking interrupt?" and inverted, was 87% accurate. It missed the people still mid-thought, so code now enforces a hard 0.5 s minimum of VAD silence.
  - `silence_cost` was 12%, sat near 0.4 on every snippet, and was moved to code.
  - `asserted_state` was 56%, and the claim-versus-check comparison moved to code.
  - `self_repaired` was 69%, which is a weak vote.
  - Decider's one real gain here was the speak gate, which combined signals: held-out F1 0.83 (3 false interrupts, 1 miss) vs 0.78 for silence ≥1.5 s alone and 0.76 for always speak (F line 26). The gate had only 18 cases, and the gate was built from Decider's yes/no probabilities combined in code (Gate.ts), not from a state-in-prompt decision.
- **Wording.** Short plain wording beats definitions (claim AUC 0.894 vs 0.954), persona prompts and contextual calibration do nothing or hurt, and examples dropped AUC from 0.96 to 0.89 (F lines 12, 130-142). Describe options by what they are (check descriptions 0.89 vs claim-shaped options 0.64).
- **Negation breaks fixed thresholds.** The negated gate question ("did everyone accept it?") made the gate never speak (F1 0), because probabilities shift under negation (F line 141).
- **Calibration.** Raw yes-probabilities sit in 0.2-0.8 (ECE 0.24-0.59). Platt scaling on dev gave 0.02-0.09, and finished-turn F1 went from 0.00 to 0.96 after Platt (F lines 13, 70).
- **Batching.** 1 vs 8 questions differ by 0.002 in probability (1 flip in 420), with p50 of 46 ms vs 93 ms (F line 77). This supports asking many narrow questions over the same state.
- **Persistence belongs in code.** Waiting 3 turns took false interrupts from 9/12 to 0/12, and a keyword persist=3 rule also got 12/12 (F line 16, 74).
- **Decider vs LLM.** The 120B Nemotron got claim F1 0.98 and route F1 0.95 with a rubric and no reasoning, at p50 1.2 s and p95 3.0 s. Decider got 0.89 and 0.81 at about 90 ms (F lines 159-168). Decider's argument is latency, cost and calibrated confidence, not accuracy, and the LLM's accuracy came with more context (6 turns, catalogues, flagged claim, silence length).

## Assessment

**Good fit for "give Decider a short, text-shaped slice and ask a narrow yes/no".**
- Language judgements on one or two items, not on a whole state dump:
  - Is the latest line a claim?
  - Is it addressed to Egg Head?
  - Was this line a correction of claim X (pass the claim text plus the latest line)?
  - Does this reply answer question Q (pass the question and the reply)?
  - Does this line park or close the topic?
  - These are classification-like and short, the regime where JevBench shows 1.0 on `routing_hard`, `tool_selection` and `extraction`, and where Egg Head measured AUC 0.95-1.0 (inferred mapping).
- "Has someone else already answered Q" is also reasonable if framed as one yes/no over the question plus the few lines since it was asked, not over a full ledger (inferred; closest evidence is the 0.96 AUC claim result at window 1 and `multi_hop`/`long_policy` collapse as context grows).
- Combining Decider's probabilities in code, as the speak gate does today, rather than asking Decider to decide.
- Anything needing a batch of narrow questions about the same state, since batching is nearly free.

**Poor fit.**
- Handing Decider the whole program state and a 4-way "flag / answer / ack / stay quiet" choice. Reasons:
  - N-way choice underperformed paired yes/no by 20+ F1 points (0.70 vs 0.93).
  - Option-order flips on a third of items.
  - More state context lowered AUC (0.91 to 0.77).
  - The model "reads the extra text and cannot use it".
  - Multi-condition policy judgements sit in the weak band (`judge_hard` 0.588, `tradeoff` 0.50, `multi_hop` 0.44). A "should I speak now" decision depends on cooldown, silence, status and severity together (inferred).
- Anything involving time or number comparison: silence length vs threshold, "how long since Egg Head last spoke", cooldown, claim age or counts of turns. `temporal_numeric` is 0.267, and Egg Head's `silence_cost` and timing-in-prompt results agree. Keep these in code.
- Ranking or severity ("how costly is it to stay quiet?"): `score` is the weakest primitive and `silence_cost` scored 12% with outputs stuck near 0.4.
- Negated or "would I interrupt?" style self-referential questions: the same hazard appeared in F (AUC 0.30 with pause; negation broke thresholds).

**Practical middle path (inferred).** Replace the per-state choice with several short yes/no questions, each seeing only the text it needs (a claim plus the latest line; a question plus the last few lines). Keep timing, cooldowns and the state machine in code, and combine the probabilities in the gate as it already does. If you want Decider to see program state, serialise a small kv snippet (a handful of fields, well under the 3072-token flat region) and test against your frozen dev/held-out split, since the repo has no evidence for or against state formats. Calibrate each question with Platt on labelled traffic.

If the in-prompt-state decisions stay valuable, the repo's documented fix is fine-tuning on a few thousand labelled Egg Head rows (SKILL.md Phase 4 tier 4). That needs more and better-audited labels than the current 273 self-written lines, plus a GPU of at least 24 GB. It would be the only way to make the "state in, decision out" shape reliable (inferred from the in-mix 0.96 vs unseen 0.60 `noul` gap).
