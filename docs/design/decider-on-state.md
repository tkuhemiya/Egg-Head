# Giving Decider Egg Head's state: what fits

The question was whether some of the agent-mode review findings (since fixed by the Bridge rework, [`bridge-rework/README.md`](bridge-rework/README.md)) could be solved by giving Strands Decider Egg Head's program state and letting it pick the decision.

The evidence is the Decider repo (docs, JevBench evaluations, the Strands example, the customize skill) and our own campaign ([`research/decider/FINDINGS.md`](../../research/decider/FINDINGS.md)). The source of each claim is given with it.

## Short answer

Partly. There are two ways to give Decider state.

- **Fits: a small slice of state and a narrow yes/no question.** For example, give it one open claim and the latest line, and ask whether the line corrects that claim. This beats the regexes we use today for corrections, parking and "did someone else answer". (That's a hypothesis; it still has to be measured.)
- **Doesn't fit: the whole state and "what should Egg Head do now?"** This is the shape Decider is weakest at. Every piece of evidence below points that way.

## Evidence

| Shape | Evidence | Verdict |
|---|---|---|
| One N-way "flag / answer / ack / quiet" choice | 3-way choice macro-F1 0.70 vs 0.93 for paired yes/no (FINDINGS exp 3). The top answer flips on 9 to 33% of items when the option order changes (exp 2). | Poor fit |
| A long state dump | Claim AUC 0.91 with the latest line only, 0.80 with 3 lines, 0.77 with 6 (exp 1). Decider "reads the extra text and cannot use it" past about 3k tokens: `long_policy` 0.368 (decider `evaluation/jevbench.md`). | Poor fit |
| Times, counts, comparisons (silence, cooldown, claim age) | `temporal_numeric` 0.267, which "looks capability-bound for a single-pass model" (jevbench). Adding the pause length to the prompt dropped finished-turn AUC from 0.948 to 0.795 (exp 7). | Keep in code |
| Severity or cost ratings | `silence_cost` scored 12% in the spike and stuck near 0.4. `score` is the weakest primitive on unseen rubrics: 0.499 (decider `evaluation/results.md`). | Keep in code |
| Policies with several conditions | `judge_hard` 0.588, `multi_hop` 0.444, `tradeoff` 0.50 (jevbench). | Poor fit |
| Self-referential or negated questions ("would I interrupt?") | AUC 0.57 on text, 0.30 with the pause (exp 7). The negated gate question made the gate never speak (exp 10). | Avoid |
| A short state and a narrow yes/no | `routing_hard`, `tool_selection` and `extraction` all score 1.0 (jevbench). Our claim AUC was 0.96 and addressee 1.0 (exp 1). Batching is nearly free: 8 questions take 93 ms vs 46 ms for 1 (exp 8). | Good fit |
| Combining Decider's probabilities in code | The speak gate scored held-out F1 0.83 vs 0.78 for silence alone. That is Decider answering questions and code deciding. | Keep |

## The findings, one by one

| Review finding | What it is | Decider can help? |
|---|---|---|
| 1. Barge-in on unconfirmed or corrected claims | State machine. The "is the speaker about to act on R?" part is language. | The guard is code. The `act` question could name the resource ("telling someone to act on orders-db now?") instead of being generic. |
| 2. "On it" never answered | Failure path | No: code |
| 3. A failed second look counts as confirmed | Policy, already decided | No: code |
| 4. Jobs forked before commit | Concurrency | No: code |
| 5. A later true claim no longer repairs an earlier one | Language: does this line correct claim X? | **Yes.** Ask a per-claim yes/no with the claim text and the latest line. Today `rep` asks about "the flagged claim" in general, and the REPAIR regex applies to every claim at once. |
| 6. Parking blocks every claim | Language: does this line set aside the topic of R? | **Yes.** Ask per open resource instead of using the global `PARKED` regex. |
| 7. Back-to-back lines, own speech counted as silence | Timing | No: code (temporal_numeric) |
| 8 to 11. Ticker death, deadlines, security, atomicity | Engineering | No: code |
| Request handling: "a different speaker talked, so the question is answered" | Language: does this reply answer question Q? | **Yes.** Ask a yes/no with the question and the lines since it was asked. |
| A ready answer about a topic the call has moved on from | Language: is the call still on Q's topic? | **Possibly.** It's a new question. |

## Plan

1. **W3 fixes every code and state-machine finding as code.** Each of the three language judgments (corrects claim X, parks topic R, answers question Q) goes behind one seam: a small function from (item, recent lines) to a probability. The current rule sits behind it at first, so W3 changes no behaviour that has not been measured.
2. **W5 measures scoped questions against the rules (exp 12).**
   - Build labelled sequences in which a claim or question is followed by a few lines.
   - Score four variants on frozen dev and held-out splits:
     - today's rule (regex, or speaker change);
     - the generic Decider question;
     - the state-scoped yes/no question (claim or question plus the latest line, kv format);
     - the whole-state N-way "what now" choice, as a check of the prediction above.
   - Pre-register the choices, Platt-calibrate on dev, and score held-out once.
   - The seam takes whichever variant wins on held-out.

   This needs the hosted Decider, which this environment's network policy currently blocks.
3. **Fine-tuning** is the documented way to make "state in, decision out" reliable. In-mix `noul` scores 0.961 vs 0.596 on unseen tasks (decider `evaluation/results.md`). It needs a few thousand audited rows per decision and a GPU with at least 24 GB (decider `skills/customize-decider`). That is worth it only if exp 12 shows the scoped questions are the bottleneck.
