# Explorer: the decision layer (Router, Gate, Conversation, Decider questions and thresholds)

_A delegated report from 23 Oct 2026, kept as written. Line numbers are at the commit it names or at 7dd7885 (before this PR). Treat claims as findings, checked where docs/handoff/continue.md says so._

## Components Found
- /home/user/Egg-Head/src/Questions.ts: all Decider wording, the kv and gate renderers, the claim logistic combo, and Platt scaling for "finished". Held to the Python research code by test/Questions.test.ts.
- /home/user/Egg-Head/src/Router.ts: ClaimCheckRouter. Stage 1 asks the claim layers and the asserted state. Stage 2 picks the resource and then the check, and `decide` applies T_CLAIM and T_ROUTE.
- /home/user/Egg-Head/src/Gate.ts: pure speak gate with six ordered reasons, REPAIR and PARKED regexes, and BASE_COST.
- /home/user/Egg-Head/src/Conversation.ts: addressed, open-question and barge-in questions, their thresholds, the "trails off" regex, and the canned spoken lines.
- /home/user/Egg-Head/src/Ledger.ts: immutable list of contradicted claims that have not been raised.
- /home/user/Egg-Head/src/Compare.ts: asserted state vs check status gives supports, contradicts or inconclusive. Falls back to a regex when Decider says `unclear`.
- /home/user/Egg-Head/src/Checks.ts: CHECKS registry (the descriptions are Decider option labels) and MockSource.
- /home/user/Egg-Head/src/Decider.ts: DecisionModel provider (HTTP and Scripted) with batching, caching and retry.
- /home/user/Egg-Head/src/Bridge.ts (outside my slice, read only for wiring): `hear` ~L360, `decide` ~L154, `converse` ~L295, `tick` ~L488, `partial` ~L509.

## Flow
Per finished line, `Bridge.hear` (Bridge.ts:360):
1. Append the turn. Window is 12 turns (WINDOW_TURNS, Bridge.ts:36).
2. In parallel (Bridge.ts:367-372):
   - **Router `route`** (Router.ts:162).
     - Stage 1 sends one request with `renderKv(turns,1)` (latest line only). It has 4 claim yes/no questions plus the asserted state asked in 2 orders (forward and reversed), 6 questions in total.
     - The four claim layers (Questions.ts:58-64) are:
       - short: "Does the latest speaker state a fact about the current state of a computer system or service?"
       - fact: "…saying how something is right now, as a fact rather than a guess, plan or question?"
       - status: "…report a status, number or observation, such as fine, down, slow, errors, CPU, or a deploy?"
       - hedge: "…unsure, guessing, asking, or saying what they will do, rather than stating what is true now?"
     - The claim probability is sigmoid(-1.304 + 1.659·logit(short) + 1.008·logit(fact) + 1.226·logit(status) − 0.655·logit(hedge)), with each probability clamped to [1e-4, 1−1e-4] (Questions.ts:67-91). The weights come from a dev fit (exp 9).
     - Claim threshold: T_CLAIM = 0.5 (Router.ts:41).
     - Stage 2 runs only for a claim and uses `renderKv(turns,3)`, which is the latest line plus two prior turns, in a `previous_turns: a | b` format. The shortlist is built from aliases in the latest line, else in the 2 prior turns, else every resource. If the latest line has exactly one alias hit, code settles the resource with no Decider call and confidence 1.
       - Resource question: "Which single named resource is the latest utterance about? Use earlier turns…". It includes an `unknown` option.
       - Check question: "Which check would verify what the latest utterance says about {resource}?". It includes a `none` option.
     - Choices are asked in rotated option orders and averaged (Router.ts:105). Confidence is (N·pmax−1)/(N−1).
     - The route fires only if isClaim, resource is not unknown, check is not none, and min(claim, resource conf, check conf) ≥ T_ROUTE = 0.25 (Router.ts:131-133).
     - Otherwise a claim becomes `escalate` and a non-claim becomes `ignore`. An optional Escalator service (an LLM cascade) re-routes escalations (Bridge.ts:397); it is untested.
   - **Gate or turn questions** on `renderGate` (Questions.ts:41): the last 6 turns with a `LATEST >>>` tag, a "Silence since the latest speaker stopped: X s" line, and the flagged claims. Without an Investigator they are asked only if a claim is open (`rep`, `fin`). In agent mode they are always asked, with `addr` and `ask` added.
3. `finishedP = Platt(fin)` = sigmoid(1.412·logit(raw)+3.407) (Questions.ts:165-167). `interruptP = 1 − finishedP`. These are stored in `gateSignals` only if a claim was already open before this line (Bridge.ts:375).
4. If the route is `check`, `source.run(check, resource)` runs the check and `Compare.compare(asserted, status)` gives a verdict.
   - `contradicts` adds the claim to the Ledger (dedup by check+resource while still open).
   - `supports` sets `supportsOpen` if a same-check, same-resource claim is already open. That counts as a repair ("ledger").
   - `unclear` falls back to the `inferAsserted` regex (Compare.ts:271).
5. Agent mode only (Bridge.ts:454-486), checked in this order:
   - The same speaker is still talking to Egg Head: the text is appended to the listening request.
   - `namesEggHead` regex AND addr ≥ 0.25: a new "addressed" request.
   - Contains "?" AND ask ≥ 0.3 AND route is not `check`: an "open" request.
   - Otherwise, if a different speaker talks while an open request is listening, it is dropped ("X answered; Egg Head stays out").
   - Addressed wording: "Is the latest speaker talking to Egg Head, the AI assistant, and asking it to check, answer or do something?"
   - Ask wording: "…asking the people on the call a question about the current state of a system, service, metric or recent deploy?"
6. `step` (Bridge.ts:344). In agent mode, `converse` runs first:
   - Say a ready answer if `floorOpen`: silence ≥ 0.5 s AND (finishedP ≥ 0.5 OR silence ≥ 1.2 s).
   - Reply to an addressed request via `readyToReply` (Conversation.ts:384). In order: silence ≥ 4.0 s means ready. Otherwise `trailsOff` (a regex for a trailing filler or comma) means not ready. Otherwise finishedP < 0.5 means not ready. Only then does it say the ack "On it, X." and dispatch an Investigator answer job.
   - An open question that nobody answered, where the same speaker is still the latest and silence ≥ 2.5 s (OPEN_SILENCE_S), gets "I can check that."
   - If none of those speak, fall through to the claim gate.
7. Claim gate, `Bridge.decide` then `Gate.decide` (Gate.ts:273). It looks only at the oldest open claim: `L.open()[0]`, or in agent mode the oldest with `agent === "confirmed"` (Bridge.ts:154). Speak only if all six reasons hold, evaluated in this order (the first false one is `blockedBy`):
   1. persisted: at least one turn since the claim. Research exp: persist=3 gave 0 false interrupts, but the code uses ≥1, not 3.
   2. not_repaired: none of the following hit. Any one of them closes the claim silently (Bridge.ts:192-196).
      - A later supporting claim ("ledger").
      - REPAIR regex on later turns: wait, hold on, are you sure, how sure, I was looking/wrong, that's not right/true, actually.
      - rep ≥ 0.45 ("decider"). Wording: "After the flagged claim, did someone on the call already say it was wrong, or question whether it was right? Agreeing with it is not a correction."
   3. min_silence ≥ 0.5 s.
   4. floor_open: floorP ≥ 0.5 OR silence ≥ 1.2 s.
   5. worth_it: costLevel ≥ 2.
   6. cooldown: 30 s since Egg Head last spoke.
   - The speak line comes from `writer.write` (Bedrock or a template), or `flagLine` when the Investigator supplied a fact.
8. `tick(silenceS)` (Bridge.ts:488) re-runs `step` on silence with no new Decider call. It reuses the stale `gateSignals` and `finishedP` from the last utterance.
9. Barge-in, `Bridge.partial` (Bridge.ts:509). This applies to a live partial transcript.
   - Code filter: an alias in the partial text matches the resource of an open claim.
   - It re-asks only when 2 or more new words have arrived.
   - It asks one Decider question, `act`: "Is the latest speaker telling someone to take an action on a system right now, such as restart, roll back, scale up or fail over?" The input is kv, window 1.
   - If act ≥ 0.3 (T_DIRECTIVE), it says "Sorry to cut in, X: <fact>" and marks the claim raised. It ignores the gate: no silence, no cooldown, no persistence, no cost check.

## Thresholds and evidence
| Item | Value | Evidence |
|---|---|---|
| T_CLAIM | 0.5 | The weights are fit on dev (exp 9). Held-out claim F1 0.89, P 0.88 R 0.90. |
| T_ROUTE | 0.25 | Grid-searched on dev. Held-out routing P 0.81 R 0.81. |
| Platt "finished" | fit on dev | Raw F1 0.00 at 0.5; after Platt 0.96 (dev). |
| T_FINISHED | 0.5 | Applied to the Platt-scaled value. |
| T_FLOOR | 0.5 | Reuses the finished/Platt value, so it is calibrated. |
| T_SELF_REPAIRED | 0.45 | Raw probability, an uncalibrated "weak third vote". The question scored 69% in the pass-2 spike. Exp 10 found the contrastive wording is noise. |
| T_ADDRESSED | 0.25 (was 0.5) | Uncalibrated, per commit 761a562. |
| T_ASKS | 0.3 (was 0.5) | Uncalibrated. |
| T_DIRECTIVE | 0.3 (was 0.5) | Uncalibrated. |
| T_MIN_SILENCE_S | 0.5 | Rule-based. Exp 7: pause≥0.5 s F1 0.95. |
| T_SILENCE_S | 1.2 | Rule-based. |
| COOLDOWN_S | 30 | No evidence. |
| REPLY_MAX_WAIT_S | 4.0 | No evidence. |
| OPEN_SILENCE_S | 2.5 | No evidence. |
| BASE_COST | per check | A hand-set table, no evidence. |

- Commit 761a562 lowered addr/ask/act from 0.5 to 0.25/0.3/0.3. The reasoning is that raw Decider probabilities run low, so Decider "only has to not say no". The commit message says the dashboard shows the scores for checking them on the first live run, so the cut-offs are guesses.
- There are no research numbers for addr/ask/act in this file:
  - Conversation.ts header: "These questions have no research numbers behind them yet".
  - FINDINGS exp 3 did evaluate addressee separately: the best dev threshold was addr 0.4, and held-out F1 was 0.86, with the name keyword at 1.00. So 0.25 is looser than the only data point.
  - The `ask` and `act` questions have no research at all.
  - The addr and ask questions run on the gate transcript (6 turns, tagged, with the silence line), not the kv latest-line format that exp 1 favoured.

## The park regex (Gate.ts:54-62, used at :101)
- Wording: `\bpark(ed|ing)?\b`, `not in the (\w+ )?path`, `set (that|it) aside`, `stay on`, `back to that later`, tested against `laterTurns` (every turn after the claim, not only the next one).
- Effect: `costLevel` returns 1 as soon as any later turn matches. Level 1 is below T_COST_LEVEL = 2, so `worth_it` is false and the claim is blocked.
- A parked claim is NOT closed. `repairedBy` is none, so the ledger item stays open.
- Consequences:
  - Parking is permanent for that claim. No later turn un-parks it.
  - In non-agent mode, a parked claim sits at the head of `L.open()[0]` forever. `gateItem` looks only at the oldest open claim, so a later, unparked, genuinely wrong claim is never gated or spoken. This is head-of-line blocking.
  - `partial` barge-in still fires on a parked claim. It looks at any open item and ignores the gate, so Egg Head could barge in on a topic the call deliberately parked.
  - "stay on" is broad. "stay on the line" or "stay on call" would park any open claim.
  - A topic parked for a different reason (say "park the deploy question") parks an unrelated open claim, because matching is not per resource.

## Decider provider (Decider.ts)
- Batching:
  - Max 8 questions per request (hosted API 422s above that). Larger sets are chunked and the parts merged by question key (Decider.ts:225-241).
  - Router comment: "rotations share a batch", the four claim layers ride in one request with two asserted orders, and a candidate's check questions share the resource request when ≤ 8.
- Concurrency: a Semaphore of 1 by default (hosted API 429s a third concurrent request). `hear` runs the router and the gate in parallel, but at the HTTP layer they queue. So one line costs ≥ 2 serial requests (stage 1, stage 2, plus the gate batch). Research p50 was ~90 ms each, so ~3 requests/line.
- Cache: `Cache.makeWith` of 512 entries. The key is the JSON of model plus request. A success is cached forever, a failure has TTL 0. Identical states return cached answers.
- Retry: `HttpClient.retryTransient` with exponential backoff from 250 ms plus jitter, 5 times. The timeout defaults to 300 s per request. This is long for a live call: a hung request blocks the lock for minutes.
- Error mapping: HTTP status errors, decode errors and transport errors become AiError. The error body is kept.
- If `hear` fails, the `Bridge` lock is held for the whole `hear` (a Semaphore of 1). `partial`, `tick` and `hear` therefore serialise, so a slow Decider also delays barge-ins.

## Files Read
src/Questions.ts, Router.ts, Gate.ts, Conversation.ts, Ledger.ts, Compare.ts, Decider.ts, Checks.ts (top 60 lines), Bridge.ts (parts, lines 135-570), research/decider/FINDINGS.md, AGENTS.md (top), `git show 761a562`.

## Boundaries
- Incident-call specific:
  - ALIASES, CHECKS and BASE_COST, which are hardcoded to orders-db, payments-api and so on.
  - The wording of claim, ask and act (about "a computer system or service" and "restart, roll back, scale up").
  - The `HEAD` string "Egg Head".
  - The Compare statuses (healthy, degraded, down, changed, unchanged).
- General to any voice agent:
  - The gate shape: persistence, repair keywords, VAD min silence, a floor from a calibrated finished-turn question, a cost threshold and a cooldown.
  - `readyToReply` with `trailsOff`.
  - The Platt/logit combo and rotation-averaging machinery.
  - The Decider provider.

## Non-Obvious Things
1. The gate transcript includes a "Silence … s" line, but FINDINGS exp 7 says to keep timing out of the prompt: adding the pause dropped finished-turn AUC from 0.948 to 0.795. The Platt fit (exp 6) was on a prompt format that may differ. The research "would-interrupt" question was useless, so `interruptP = 1 − finished` is the workaround.
2. `gateSignals` (rep and fin) are only stored when a claim was already open at `hear` time (Bridge.ts:375). For a claim added in this same turn, `signalsOf` returns defaults: selfRepairedP 0.0 and interruptP 0.5, so floorP is 0.5 and passes exactly at T_FLOOR = 0.5. `tick`s then reuse the stale signal from the last utterance.
3. Persistence is laterTurns > 0, so one turn. Research said 3 turns gives 0 false interrupts and 2 turns gives 3/12. The gate is therefore laxer than the evidence says, although the cooldown, min_silence and repair checks also apply.
4. The contradicted-claim `Compare` falls back to the regex `inferAsserted` when Decider answers `unclear` (10 of 25 pass-2 cases). Order matters: the "didn't deploy" pattern comes before "deploy".
5. `Ledger.add` dedups by check+resource only while the earlier item is open, so a raised claim can be re-flagged by the same person repeating it. The 30 s cooldown limits that.
6. In `hear`, an `ask` open request is created only if `rt.action !== "check"`, so a question that routes to a check never becomes an open request.
7. Open request dropping uses `dropOpen(speaker)`: any new addressed or open request by the same speaker drops their earlier open one.
8. In `partial`, the `asked` Map (Bridge.ts:~504) is never cleared, and the key is `turns.length|resource`, so it is fine per turn but unbounded in growth.
9. `T_FINISHED` and `T_FLOOR` are both 0.5 but defined separately. The Bridge `floorOpen` uses `G.T_FLOOR` on `s.finishedP`.
10. An obsolete comment in Gate.ts says the Decider inputs are "noul"; the code now takes already-computed probabilities.
11. The docstring in Gate.ts says `spike/egghead_gate.py` is the Python original and parity tests hold the port to it (test/Gate.parity.test.ts). I did not read these.

## Open Questions
- Whether `Bridge.tick` in non-agent mode can ever speak for a claim made in the latest turn (persisted requires ≥1 later turn) when the call goes silent after the claim. I read this as no: silence alone cannot open the gate because persistence needs another turn.
- Whether anything un-parks or expires a parked ledger item. I found none in the files read; checking the demo runner and Investigator.ts would confirm.
- What actual addr/ask/act scores look like on a live run (the dashboard shows `gateScores`).
- Whether the Platt parameters are valid for the production gate prompt, which differs from the research prompt in that it now includes the flagged-claim line and the combined 4-question turn batch. Platt was fit with `rep` and `fin` only. Exp 8 says batching changes answers by less than 0.002, which supports it.
