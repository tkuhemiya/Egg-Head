# The work that needs a network

This is a brief for an agent running on a machine that can reach the hosted Decider, OpenRouter, Hugging Face and AWS. Nothing here has been run yet: the cloud environment the Bridge rework was built in blocked those hosts.

## Ground rules

- **Branch.** Work on your own branch off `main` (`git switch -c research/live-runs origin/main`) and open a PR into `main`. Keep your changes inside the paths each task names.
- **Secrets.** Never commit a key. `.env` is gitignored. The research scripts read OpenRouter's key from `~/.secrets/openrouter.env` (`OPENROUTER_API_KEY=...`).
- **Honesty.** Every number you report comes from a file you committed. Never tune on `heldout`: score it once, after the choices are written down in a `PREREGISTERED_*.json`. If something fails, commit the failure and say so.
- **Read first.** `AGENTS.md`, `README.md`, `research/decider/README.md`, `research/decider/FINDINGS.md`, `docs/design/decider-on-state.md` and `docs/design/behaviour-harness.md`.

## 0. Check the machine (5 min)

```bash
git switch -c research/live-runs origin/main
npm install && npm run check && npm test          # expect: all tests pass
curl -sS -X POST https://api.decider.cloud/v1/systemone -H 'content-type: application/json' \
  -H 'User-Agent: egghead-research/0.2' \
  -d '{"model":"strands-decider-2b","state":"Sam: orders db is fine","questions":{"q":{"type":"noul","instructions":"Does the latest speaker state a fact about a system?"}}}'
```

The first Decider request after idle can take about 30 s, because of a cold start. If the request body shape above is rejected, copy the shape from `research/decider/scripts/lib.py` `ask()`.

## 1. Has the hosted Decider changed? (10 min, Decider only)

```bash
npm run replay -- heldout
```

This must reproduce exp 9: claim P 0.884, R 0.905; route P 0.806, R 0.806. The results are in `research/decider/results/runtime_heldout.json`. If the numbers moved, the hosted model changed. Stop, commit the new file, and report the difference: every later number depends on this.

**Deliverable:** the regenerated `research/decider/results/runtime_heldout.json` and a one-line verdict.

## 2. The first live runs of agent mode (1 h, Decider + AWS)

This is the README's first open item. You need AWS credentials for Polly, plus Bedrock for pi (`AWS_BEARER_TOKEN_BEDROCK` or the credential chain, `AWS_REGION`) in `.env`. Set `EGGHEAD_VOICE_REGION` to the nearest region.

1. Run each command 5 times. After each run, score it with `npx tsx scripts/check-run.ts latest`. The run file lands in `demo/out/runs/`, and the server also prints the score.

   ```bash
   npm run demo -- --autostart                      # live Decider, pi on Bedrock, Polly
   npm run demo -- --agent none --autostart         # live Decider, no agent
   ```

2. For each run, record:
   - the score ("N of 18 lines");
   - each failing line from the check-run table;
   - the `addressed`, `asks` and `directive` scores on each line (`gateScores` in the run file's `event` entries);
   - the Decider latency (`deciderMs` on each `event` entry; take the p50).
3. Copy the run files to `research/decider/results/live/agent-mode/` and commit them. They are the only evidence for the uncalibrated cut-offs (`T_ADDRESSED 0.25`, `T_ASKS 0.3`, `T_DIRECTIVE 0.3` in `src/Conversation.ts`). **Do not change those cut-offs.** Task 3 sets them properly.

**Deliverable:** `research/decider/results/live/agent-mode/*.json` and `research/decider/results/live/agent-mode/SUMMARY.md`. The summary has a table: run, agent, score, failing lines, Decider p50, plus the min, median and max of the score for each question on the lines where it should fire and on the lines where it should not.

## 3. Experiment 12: the new questions, and the Decider-on-state idea (1 to 2 days, Decider + OpenRouter)

**Goal.** Set the cut-offs for `addr`, `ask` and `act` from evidence. Then test whether narrow, state-scoped Decider questions beat today's rules for three judgments: "does this line correct claim X", "does this line park topic R" and "does this reply answer question Q". The rationale is in `docs/design/decider-on-state.md`. Use the same method as exp 1 to 11.

### 3a. Data (`research/decider/data/exp12/`)

Write items as JSONL, one file per judgment. Each item has `id`, `split` (dev or heldout, assigned 50/50 by a seeded shuffle *before* labelling), the input (for example `turns` and `claim`, or `question` and `reply`), the gold `label` (true or false), and `kind` (`easy`, `hard_negative` or `hard_positive`). Use the incident world in `data/world.json` (resources: orders-db, payments-db, checkout-queue, orders-api, payments-api, auth-service). Also write at least 30% of the items about **other** settings, so nothing is tuned to the demo: a product launch call, a support escalation, a planning meeting.

| File | Judgment | Size | Hard cases to include |
|---|---|---|---|
| `addressed.jsonl` | Is the latest speaker asking Egg Head (the AI) to do something? | 120 | Names Egg Head without asking ("Egg Head was wrong earlier"). Asks without the name, after Egg Head just spoke. Asks someone else. Mid-sentence ("Egg Head, can you check the, uh"). |
| `asks.jsonl` | Is the latest speaker asking the call about the current state of a system? | 120 | Rhetorical questions. Questions about people or plans. Questions with no "?". Statements with "?". |
| `directive.jsonl` | Is the latest speaker telling someone to act on a system now? | 120 | Past tense ("we restarted it"). Conditional ("if it gets worse, roll back"). Proposals ("should we fail over?"). Mentions only. Partial lines cut mid-word. |
| `corrects.jsonl` | Given claim X and the latest line, does the latest line say X is wrong? | 150 | A plain contrary fact with no keyword ("CPU's at 98"). A correction of a *different* claim. Agreement. "actually" in an unrelated sense. |
| `parks.jsonl` | Given resource R and the latest line, does the call set R's topic aside? | 120 | Parking a different topic. "Park that" referring back to R. "Stay on the line". Coming back to a parked topic. |
| `answered.jsonl` | Given question Q (by A) and the lines since, has someone answered Q? | 120 | A reply on another topic. A partial answer. A follow-up question. "Let me check". The asker answering it themselves. |

**Labels.** Two independent labelling passes, each blind to the other: for example, two different strong models, each given only the item and the written label definition (put the definitions in `data/exp12/LABELS.md` first).
- Compute Cohen's kappa for each file.
- Write every disagreement to `data/exp12/disagreements.jsonl`. **Send that list to the project owner to decide.** Do not settle disagreements yourself.
- After the owner's decisions, freeze the data with `sha256sum data/exp12/*.jsonl > data/FROZEN_exp12.sha256`.

### 3b. Variants (`research/decider/scripts/exp12_*.py`)

Use `lib.py` (cache, backoff, User-Agent) and `common.py` (renderers). Write `PREREGISTERED_exp12.json` before touching `heldout`.

- For `addressed`, `asks` and `directive`: try the current wording (copy it from `src/Conversation.ts`) and 2 to 3 alternatives. Try kv format with the latest line only, and the current gate format (`renderGate`, 6 turns plus a silence line; exp 7 found a silence line lowers AUC, so test both). Pick the wording and format on dev, Platt-calibrate on dev, choose the threshold for F1 or for a fixed precision ≥ 0.9 (write down which), then score `heldout` once.
- For `corrects`, `parks` and `answered`, four variants:
  1. **Today's rule**, ported to Python:
     - `corrects` is the `REPAIR` regex in `src/Gate.ts`, plus "a later true claim on the same check and resource";
     - `parks` is the `PARKED` regex, applied to every claim;
     - `answered` is "a different speaker spoke next" (`src/Bridge.ts` request handling).
  2. **The generic Decider question** in use today (`SELF_REPAIRED` in `src/Questions.ts` for `corrects`; none exists for the others, so write one).
  3. **The state-scoped yes/no question.** The claim or question is spelled out, and the input is the latest line or the lines since, in kv format.
  4. **A whole-state N-way choice** ("flag / answer / ack / stay quiet") over a kv dump of the open claims, open questions and the last 6 lines. Decider is predicted to lose here, so this variant tests the prediction.
- **LLM baseline:** the best variant's question, sent to a free OpenRouter model of the same family as the Bedrock models used here (Nemotron). Find the current slug at https://openrouter.ai/models?q=nemotron and record it. Run it with `LLM=<slug>` through a copy of `llm_baseline.py`.

### 3c. Report

Add an "Exp 12" section to `research/decider/FINDINGS.md` in the existing style:
- the hypothesis and setup;
- a dev table and a held-out table, with AUC, F1 at the chosen threshold, precision, recall, ECE (raw and Platt), latency p50 and n;
- kappa and the number of disagreements;
- what to put in `src/Conversation.ts` (wording, format, Platt `a`/`b`, threshold) for `addr`, `ask` and `act`;
- for each of `corrects`, `parks` and `answered`: rule, generic or scoped, and the evidence.

Put the parameters in `research/decider/results/exp12_platt_dev.json`. Do **not** edit `src/`. The runtime change is made on the main branch from your numbers.

**Deliverable:**
- `data/exp12/*` with `FROZEN_exp12.sha256` and the owner-settled `disagreements.jsonl`;
- `scripts/exp12_*.py`;
- `results/PREREGISTERED_exp12.json`;
- `results/exp12_{dev,heldout}.json`;
- `results/exp12_platt_dev.json`;
- the FINDINGS section.

## 4. Later


- **Blind test of the agent prompt** (`demo/agent/bin/egghead` now takes `--status unknown`).
  - Add 6 to 10 cases to `data/aws.json` (copy it to `data/aws-eval.json`; the stand-in `aws` reads `EGGHEAD_AWS_DATA` if set, or add that) in which the data cannot settle the claim, or contradicts it subtly.
  - Write tasks phrased like real ones, with no words like "eval", "test" or "judge" anywhere the agent can see.
  - Run pi with the old `demo/agent/SYSTEM.md` (from git history) and with the new one, several times each.
  - Have a separate judge model, which sees outputs only by A/B label, count confident statements that are wrong and correct "couldn't tell" reports.
  - Commit everything under `research/agent-eval/`.
- **Latency (after a `scripts/latency.ts` harness lands).** Run it live with at least 5 alternating runs per side, and report the median and range plus what limits each stage.

## Bring back

Push your branch and open a PR into `main`. List in the PR:
- what ran;
- what failed;
- where each deliverable is;
- the `disagreements.jsonl` decisions, with who made them.
