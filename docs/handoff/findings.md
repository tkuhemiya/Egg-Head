# Findings and context, in one place

This file collects everything learned on this branch that the code alone doesn't show. Each item gives its source. The raw reports behind it are in [`reports/`](reports/), kept as written, and the plan built on them is in [`continue.md`](continue.md).

## 1. Environment

- **Toolchain.** Node v22.22.0, Effect 4.0.5, vitest 5.0.5. TLA+ tools come from `https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar`; `spec/check.sh` downloads them to `~/.cache/egghead/`, or set `TLA2TOOLS=<jar>`. TLC needs Java.
- **Blocked hosts.** The cloud environment this branch was built in blocks `api.decider.cloud`, `openrouter.ai` and `huggingface.co`; the proxy answers 403 to CONNECT. AWS credentials were not available either. So nothing on this branch was run against the live Decider, Bedrock, Polly or Transcribe. Every live claim in the docs comes from earlier work (FINDINGS.md, 22 Oct).
- **What works offline.** `npm test`, `spec/check.sh`, and the rehearsal demo with the real pi agent in a pty (`--rehearsal`) all run with no network. A rehearsal run scores 18 of 18 lines.
- **Test counts.** 65 tests at the start of this branch, 105 at handoff.

## 2. Where every number in the speaking logic comes from

Source: [`reports/04-history-why-it-is-this-way.md`](reports/04-history-why-it-is-this-way.md). The tiers follow that report: Direct means the reason is written down, Supported means it was fit to data, Unknown means no record exists.

| Constant | Value | Origin | Evidence |
|---|---|---|---|
| `T_CLAIM`, claim logistic weights | 0.5, dev fit | FINDINGS exp 9 | Held-out F1 0.89 (Supported) |
| `T_ROUTE` | 0.25 | Dev grid search | Held-out route P/R 0.81 (Supported) |
| Platt for `finished` | a 1.412, b 3.407 | FINDINGS exp 6 | Raw F1 0.00 at 0.5, 0.96 after Platt on dev (Supported) |
| `T_FINISHED`, `T_FLOOR` | 0.5 on the Platt-scaled value | exp 6 | Supported |
| `T_SELF_REPAIRED` | 0.45 | Spike pass 2 | The question scored 69% and is a weak vote (Supported, weakly) |
| `T_MIN_SILENCE_S` | 0.5 | Spike gate rework (b0ffc67) | Fit after reading the 16 gate snippets; exp 7 pause ≥ 0.5 s gave F1 0.95 (Supported, not held-out) |
| `T_SILENCE_S` | 1.2 | Day-0 plan, kept by the spike | Unknown |
| `COOLDOWN_S` | 30 | b0ffc67 | Unknown; no snippet exercises it |
| `BASE_COST` table, `T_COST_LEVEL` 2 | per check | b0ffc67, after `silence_cost` scored 12% | The principle is written down; the integers are Unknown |
| `T_ADDRESSED`, `T_ASKS`, `T_DIRECTIVE` | 0.25, 0.3, 0.3 (were 0.5) | 761a562, 21 min after agent mode, no live run in between | Direct that they are guesses; the values are Unknown. Exp 3's only addressee number is a best dev threshold of 0.4 |
| `REPLY_MAX_WAIT_S`, `OPEN_SILENCE_S` | 4.0, 2.5 | 8976c97 | Unknown |
| Persistence before speaking | 1 turn (`laterTurns.length > 0`) | Gate | Research: 3 turns gave 0/12 false interrupts, 2 turns gave 3/12 (FINDINGS pattern 8). The code is looser than the evidence |

The gate itself has **no held-out evidence**. Its rules were written after reading the same 16 snippets they are scored on (`spike/REPORT-gate.md`), and the held-out snippet set was dropped in 351cc3a.

## 3. Every known defect

The first 11 are the review findings, in the order of [`../reviews/2026-10-23-agent-mode.md`](../reviews/2026-10-23-agent-mode.md). The full write-ups are in [`reports/05-review-a-opus.md`](reports/05-review-a-opus.md) and [`reports/06-review-b-sonnet.md`](reports/06-review-b-sonnet.md). The rest came from the explorers, the architecture synthesis and the harness build.

| # | Defect | Where | State |
|---|---|---|---|
| 1 | Barge-in speaks a claim nobody confirmed, one the call corrected, or one the agent would find right. It also runs with no Investigator. | `Bridge.partial` (`L.open(...)` ignores the agent state); `demo/Run.ts` and now `src/Call.ts` call `partial` in every text run | Open (W3). Owner decided the fix |
| 2 | "On it" is never answered when the agent and the direct fallback both fail (no resource named) | `background` `catchCause(logError)`; `Investigator.direct.answer` fails | Open (W3). Fix: `unknown` / "couldn't find that out" |
| 3 | A failed or timed-out second look counts as confirmed | confirm fallback = the fast check's own status | Open (W3). Owner decided: recheck, then an unverified flag |
| 4 | Jobs are forked before the state that records them commits, giving duplicate jobs and task numbers | `yield* job` before `commit` in `hear` and `converse` | Open (W3) |
| 5 | In agent mode a later true claim no longer repairs an earlier one; `supportsOpen` is not tied to the gated item | the second-look loop passes `laterClaimSupportsCheck: false` before routing | Open (W3) |
| 6 | Parking applies to every open claim; a parked confirmed claim never resolves and blocks later claims (head-of-line); `pending` never reaches 0 | `Gate.costLevel` `PARKED` over `laterTurns`; `gateItem` takes the oldest | Open (W3). Owner decided: scope to the resource. `"stay on"` in the regex is too broad ("stay on the line") |
| 7 | Egg Head's own speech is not "speaking": acks and answers don't set `lastSpokeS`, and silence keeps counting while its clip plays, so lines come back to back | `converse`; the call loop ticker | Open (W3). Owner decided: one line per gap |
| 8 | One error ends the silence ticker for the rest of the call; a failed `hear` leaves its turn with no event | ticker loop with no catch; `hear` appends the turn first | Open (W3) |
| 9 | No Bridge-owned deadline on agent jobs; queue wait is unbounded; `settle` adds up to 6 s | `background`; `AgentTerminal.submit` | Open (W3) |
| 10 | Demo security | `demo/server.ts`, `demo/Agent.ts` | **Fixed** in b629bba. Residual: pi holds its Bedrock credentials |
| 11 | `commit` can be interrupted between `Ref.set` and `PubSub.publish`, so a barge can be marked raised but never voiced | `commit` | Open (W3) |
| 12 | Only ticks speak in text mode. `hear` gets about 0.3 s of silence (the ASR delay), below the 0.5 s minimum, so every line comes from the next 250 ms tick. | call loop | By design so far, but every decision is a tick |
| 13 | A tick or partial queued behind a slow `hear` acts on the previous line's state, and can take a question someone just answered | one lock across slow calls | Open (W3 design moves slow work out of the lock; W7) |
| 14 | `lineOfTurn` is recorded before `hear` gets the lock, so the dashboard can mislabel lines if queued `hear`s run out of order | call loop | Open; check after W3 |
| 15 | Gate signals (`rep`, `fin`) are refreshed only when a claim was open before the line. A claim added this turn gets the defaults (`selfRepairedP` 0, `interruptP` 0.5, so floorP sits exactly on 0.5), and ticks reuse stale signals. | `Bridge.hear` | Open (W3) |
| 16 | The gate prompt includes "Silence since…" although exp 7 found that adding the pause dropped finished-turn AUC from 0.948 to 0.795. The Platt fit was on a different prompt format. | `renderGate` | Open (W5 exp 12 tests it) |
| 17 | A hung Decider request holds the Bridge lock for up to 300 s (provider timeout, which also counts queue time) | `src/Decider.ts` | Open (W3/W7: Bridge-side deadline, slow calls outside the lock) |
| 18 | Transcribe mode never feeds `Bridge.partial`, so there is no barge-in with real audio | `demo/Voice.ts` `transcribe` drops `IsPartial` | Open (W6) |
| 19 | `asked` (partial bookkeeping) lives outside the state Ref; it is written before the Decider call and never cleared | `Bridge.partial` | Open (W3) |
| 20 | Without an Investigator, a parked claim at the head of `L.open()[0]` blocks every later claim | `gateItem` | Open (W3, with 6) |
| 21 | `changes` has no replay; the call loop subscribes with `forkScoped` + `yieldNow`, which is a timing assumption | `Bridge.changes` | Low; note for W3 |
| 22 | The REPAIR keyword over later turns repairs every earlier claim, not just the one corrected | `Gate.repairedBy` | Open (W3 seam; W5 measures a per-claim question) |
| 23 | Two `as C.TurnAnswers` casts and scattered `agentMode` branches in `hear` | `Bridge.hear` | Open (W3 restructure) |

## 4. TLA+ counterexamples on the current code

From `spec/check.sh` at f30423e. Each is the shortest trace TLC found. Claims c1 and c2 are what people said; "right" or "wrong" is what a second look would find.

- **NeverSaysUnconfirmed:** a contradicted claim, then a partial names its resource. Egg Head barges in with the fast check alone.
- **NeverSaysCorrected:** a claim, an unrelated line, a correction ("actually…"), then a partial. Egg Head barges in with the corrected claim (the correction only closes claims the gate looks at, and barge-in looks at all of them).
- **NeverSaysRightClaimIsWrong:** a claim the agent would find right, then a partial. Egg Head barges in before the second look reports.
- **AckIsAnswered:** a question to Egg Head, the ack, then the answer job fails twice. The request stays "checking" forever.
- **ConfirmedIsResolved:** claim c2 is confirmed, a "park" line parks every open claim, then c1 arrives. c2 is never spoken or closed (worth_it fails forever), and as the oldest confirmed claim it blocks the rest.

## 5. What the behaviour harness found

From [`reports/09-harness-build-report.md`](reports/09-harness-build-report.md), which has the log excerpts.

- **Back-to-back lines (finding 7).** In the checkout call, line 13: "I can check that." (1.77 s), then the answer 1.23 s after it ends, with no human in between. `OneLinePerGap` is left out of the scenarios until W3.
- **Stuck "On it" (finding 2).** "Egg Head, can you take a look at this?" with no resource. "On it, Priya." is followed by `SupportError: no resource named in the question`, then the full 10 s and 20 s holds. The `REPLY_MAX_WAIT_S` mutant hits the same bug.
- **Barge-in on an unconfirmed claim (finding 1).** Checkout line 15 barges on Jordan's line-14 claim, which was never sent for a second look. It stays expected as `barge`, because the owner wants a tentative barge there; firm or tentative becomes observable in W3.
- **Wrong old demo labels.** The prose said "flag" on lines 2, 6 and 14, but the right behaviour is quiet: line 2 waits a turn, line 6 is corrected by line 7, and line 14 has no gap. The `why` strings are fixed.
- **Thin coverage.** `T_SILENCE_S` is caught only by `unfinished-turn.json`. No scenario covers a failed confirm job, because writing one would encode finding 3 as expected.

## 6. Strands Decider: what fits

From [`reports/07-decider-capabilities.md`](reports/07-decider-capabilities.md), summarised in [`../design/decider-on-state.md`](../design/decider-on-state.md).

- **Strong.** Short, narrow classification: `routing_hard`, `tool_selection` and `extraction` score 1.0 on JevBench. Batching is nearly free (8 questions take about 93 ms vs 46 ms for 1). Our claim AUC is 0.96 and addressee 1.0.
- **Weak.**
  - N-way choices: 0.70 vs 0.93 macro-F1 for paired yes/no, and the answer flips on 9 to 33% of items when option order changes.
  - Long state: claim AUC 0.91 with 1 line, 0.77 with 6; `long_policy` 0.368.
  - Times and numbers: `temporal_numeric` 0.267.
  - Multi-condition policy: `judge_hard` 0.588, `multi_hop` 0.444.
  - `score` on unseen rubrics: 0.499.
  - Negated or self-referential questions.
- **Calibration.** Raw yes-probabilities sit in 0.2 to 0.8. Platt-calibrate on dev before thresholding. `noul` is the worst-calibrated primitive (ECE 0.162).
- **Fine-tuning** (`skills/customize-decider` in the Decider repo) is the documented way to make "state in, decision out" reliable.
  - In-mix `noul` scores 0.961 vs 0.596 on unseen tasks.
  - It needs a few thousand audited rows per decision and 2 to 4 instruction variants each.
  - A GPU of at least 24 GB for the 2B model.
  - About 1000 test items plus 1000 calibration items per decision.
- **The 4096-token window.** The front of the state is cut silently unless `--strict-window` is set. Training rows were short (median 204 tokens).

## 7. Decisions

- **Owner decisions** (binding; the `direction` rows in `../decisions/quality-run.tsv`):
  1. Barge-in is firm when the agent confirmed the claim, tentative ("my quick check shows…, I'm double-checking") while the second look runs, and never on a corrected claim.
  2. A failed or timed-out second look re-runs the fast check. If that still contradicts, Egg Head may raise it at a gap but says it could not confirm further.
  3. One line per gap. Any Egg Head line counts as speaking, and the next needs a human turn or a few seconds of quiet. The 30 s cooldown applies to unprompted flags only, and asked-for answers are never held by it.
  4. Parking closes only the open wrong claims about the parked resource, with a dashboard note.
- **Open questions for the owner** (with recommendations): see `continue.md` W3 step 1. They cover barge-in only with an agent, "park that" with no resource named, a spoken retraction, a writer fallback, and the gap length.
- **Engineering decisions** are in the decision log with reasons and evidence. Two examples: the harness design base and grafts, and keeping timing, cooldowns and the state machine in code rather than in Decider.

## 8. Reports index

| File | What |
|---|---|
| [`reports/01-explorer-bridge-core.md`](reports/01-explorer-bridge-core.md) | `hear`, `tick`, `partial`, jobs, the lock: flows, orderings, invariants and whether each is enforced |
| [`reports/02-explorer-decision-layer.md`](reports/02-explorer-decision-layer.md) | Every Decider question's wording, input, combination and threshold, with evidence; the park regex; the provider |
| [`reports/03-explorer-demo-and-agent.md`](reports/03-explorer-demo-and-agent.md) | The demo runner, routes, run files, rehearsal, agent loop, Transcribe; what is demo-specific (before the harness moved the loop) |
| [`reports/04-history-why-it-is-this-way.md`](reports/04-history-why-it-is-this-way.md) | Git and PR history of each design choice, with evidence tiers |
| [`reports/05-review-a-opus.md`](reports/05-review-a-opus.md), [`reports/06-review-b-sonnet.md`](reports/06-review-b-sonnet.md) | The full adversarial review findings, with suggestions |
| [`reports/07-decider-capabilities.md`](reports/07-decider-capabilities.md) | The Decider repo docs and evaluations, and our FINDINGS, on giving Decider state |
| [`reports/08-harness-design-judge.md`](reports/08-harness-design-judge.md) | Scores of the two harness designs; vocabulary still to add (`certainty`, `basis`, `recheck`, `Closes`, `OneLinePerGap`, `NeverOnCorrected`) |
| [`reports/09-harness-build-report.md`](reports/09-harness-build-report.md) | How the harness was built: deviations, the mutant table, and the bugs it found with log excerpts |
| [`../design/architecture.md`](../design/architecture.md) | The synthesized architecture, with 27 hazards marked confirmed or inferred |
| [`../design/bridge-rework/design-a/rationale.md`](../design/bridge-rework/design-a/rationale.md) | The complete Bridge redesign sketch for W3 |
