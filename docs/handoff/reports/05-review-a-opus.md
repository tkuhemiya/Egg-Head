# Agent-mode review, reviewer A (Opus): full findings

_A delegated report from 23 Oct 2026, kept as written. Line numbers are at the commit it names or at 7dd7885 (before this PR). Treat claims as findings, checked where docs/handoff/continue.md says so._

## Findings (Reviewer A)

### 1. [critical] Barge-in speaks unconfirmed fast-check results, and runs with no Investigator at all
**Location**: src/Bridge.ts:520-554 (`partial`), especially :524 and :542; demo/Run.ts:237; test/Conversation.test.ts:132-146
**Finding**: `partial` picks any open ledger item naming the resource (`L.open(s.ledger).find(...)`), whatever its `agent` state: `pending`, `checking` or `confirmed`. It then speaks `item.fact ?? C.factOf(item)`. The `factOf` fallback exists only for items the Investigator never confirmed. `partial` is also not gated on `agentMode`, and Run.ts:237 calls it in every text-mode run, including `--agent none`.
**Evidence**: Intent (1) says "Egg Head never interrupts on an unconfirmed fast-check result". The barge test proves the opposite: one `hear` adds the claim as `pending`, then `partial` barges with "payments-api is healthy, 5xx rate 0.3%." from the fast check alone. Without an Investigator, the old Bridge never spoke mid-line and never marked items raised outside the gate. Now `partial` marks raised and sets `lastSpokeS` (:545). That breaks "Without an Investigator, behaviour must be unchanged". The header comment at :17 ("Without an Investigator nothing changes") is false for this path.
**Suggestion**: Return `Option.none()` from `partial` unless `agentMode`, and only consider items with `agent === "confirmed"`. Or, if barge-in on unconfirmed claims is deliberate, say so in the intent and the doc comments.

### 2. [critical] When the agent fails, the claim counts as "confirmed" from the fast check, and Egg Head interrupts with it
**Location**: src/Bridge.ts:230-231 (confirm fallback), :246-247
**Finding**: The confirm fallback is `Effect.succeed({ status: item.status, fact: C.factOf(item), by: "direct" })`. It echoes the fast check's own status back. Then `compare(asserted, item.status)` is again "contradicts", so the item becomes `agent: "confirmed"` and the gate raises it.
**Evidence**: Any agent timeout or crash (Agent.ts:162-165, :196-197) turns an unconfirmed fast-check result into a confirmed one, which is the exact outcome intent (1) forbids. It also differs from the answer path (:268), which falls back to `direct(source).answer`. `Investigator.direct.confirm` (Investigator.ts:170-175) at least re-runs the check; this fallback doesn't even do that. The note says "confirmed: ..." with `by: "direct (agent failed)"`, so the dashboard reports a confirmation that never happened.
**Suggestion**: Pick one policy and write it into the type. Either a failed second look means stay quiet (mark the item `overruled`/`skipped` with a "could not confirm" note), or the fallback must be `direct(source).confirm(task, item)`, and the intent should then admit the fast check can still trigger an interruption.

### 3. [critical] A failed answer fallback leaves the request stuck in "checking" forever, and the demo stalls on it
**Location**: src/Bridge.ts:213-225 (`background`), :268; src/Investigator.ts:179-182; src/Bridge.ts:566-568 (`pending`); demo/Run.ts:202-211, :330
**Finding**: If `inv.answer` fails, `fallback` is `direct(source).answer`. That fails with "no resource named in the question" whenever `aliasHits(question.text)` is empty, e.g. "Egg Head, what are we seeing?" or "Is anything else alarming?". Both failures go to `Effect.catchCause(Effect.logError)` (:223). The `done` handler never runs, so the request stays `state: "checking"` permanently.
**Evidence**: Egg Head has already said "On it, Priya." (:329) and never follows up. `pending` counts `checking`, so it stays above 0 for the rest of the call. Every later `waitForEggHead` line (Run.ts:207) then holds the humans for its full maximum (30 s default), and the end-of-call wait (Run.ts:330) always takes its full 20 s. The Bridge has no state for "failed".
**Suggestion**: Have `background` take an `onFailure` that commits a terminal state under the lock (request `dropped` / item `skipped`, with an AgentNote `action: "failed"`). `AgentNote.action` already has `"failed"` (:44) but nothing ever produces it.

### 4. [critical] With an Investigator, the ledger repair signal (a later true claim) is lost, so Egg Head flags claims the call already corrected
**Location**: src/Bridge.ts:408-428 (pending loop) vs :430-457 (routing) and :160-161, :170-185 (`decide`)
**Finding**: The pending loop runs before the current utterance is routed and hard-codes `laterClaimSupportsCheck: false` (:416). It decides "skip vs dispatch" without knowing that this very line is a supporting claim about the same resource. `supportsOpen` is computed afterwards and is never stored in state. It is passed only to this step's `decide`, which in agent mode looks only at the oldest *confirmed* item (:161). That item may be a different claim, or there may be none, because the pending item has only just gone to `checking`.
**Evidence**: Example: Sam at turn 0: "orders-db is fine" (contradicted, pending). Jordan at turn 1: "orders-db CPU is at 98%" (supports the check). In the loop, `repairedBy` sees no keyword, `supportsCheck=false` and a stale Decider vote, so it dispatches a confirm, which is a model call the call's own correction should have prevented. When the agent confirms, the gate runs with `supportsOpen=false` from ticks (:505, :510), and Egg Head flags something Jordan already said. Without an Investigator, this would have been closed as `repairedBy: "ledger"`. This contradicts "a claim the call corrects itself costs no model call". Separately, `supportsOpen` is matched against *any* open item but applied to whichever item `gateItem` returns, which may be a different resource. That cross-item mismatch already existed in non-agent mode, but agent mode widens it.
**Suggestion**: Route first, then run the pending loop. Record "supported later" on the ledger item itself (`L.update(..., { supportedAt: turn })`), and let both the loop and `G.decide` read it from the item instead of a per-step boolean.

### 5. [warning] Confirmed claims the gate will never raise stay open forever, so `pending` never reaches 0
**Location**: src/Bridge.ts:409-427, :566-568; src/Gate.ts:348-349, :362-363
**Finding**: The pending loop only checks `repairedBy`, not `costLevel`. A claim on a parked topic ("let's park the DB, it's not in the path") still gets a model call. It is then `confirmed`, but `worth_it` is false for good (cost 1), so it is never raised, never closed, and counted in `pending` forever. The same holds for any confirmed item blocked by cooldown until it opens again.
**Evidence**: `pending` counts `confirmed` items (:567). Every `waitForEggHead` after that waits its full maximum (Run.ts:207). The model call is wasted too, which goes against the "costs no model call" spirit.
**Suggestion**: Apply the parked/worth-it check before dispatching. When `decide` sees `worth_it` false on a parked topic, close the item (like `repairedBy`) instead of leaving it open.

### 6. [warning] The Bridge treats Egg Head's own speech as call silence, and acks/answers don't count for the cooldown, so it can talk back-to-back
**Location**: src/Bridge.ts:300-345 (`converse` never sets `lastSpokeS`); demo/Run.ts:186-194, :149-157
**Finding**: Ack and answer lines (:303-309, :329, :339) return new state without `lastSpokeS: now`. Only flags (:189) and barges (:545) set it. The demo ticker sends `tick(t - lastEnd)` every 250 ms, and `lastEnd` is not reset while Egg Head talks. So the silence keeps growing while Egg Head's own clip plays.
**Evidence**: Possible sequence: tick N: "On it, Priya." Tick N+1, 250 ms later: the gate's cooldown sees no recent speech and flags a confirmed claim. Tick N+k: the answer is ready and `floorOpen` is true (silence is large), so it speaks again. Each tick allows only one line, but nothing stops lines on consecutive ticks while the first is still being voiced. The README says speaking happens "at the next moment the floor allows", but Egg Head's own voice is counted as the floor being free.
**Suggestion**: Record `lastSpokeS` (or a `speakingUntil`) for every `said`. Either give the gate's cooldown a "speaking now" floor, or have the caller reset silence when Egg Head speaks. The Bridge can't know clip length, so `tick` needs an explicit "Egg Head finished speaking" input.

### 7. [warning] One writer/tick error permanently kills the silence ticker
**Location**: demo/Run.ts:187-194; src/Bridge.ts:133, :505
**Finding**: `tick` can fail with `SupportError` (`writer.write`, e.g. the Bedrock writer). The ticker loop has no error handling and is `forkScoped`, so the first failure ends the fiber silently.
**Evidence**: For the rest of the call, Egg Head never acts on silence again: no flags, acks, answers or open-question takeovers. Only `hear` steps remain, and those mostly arrive with silence below the 0.5 s minimum (ASR_DELAY_S = 0.3). Similarly, forked `hear` failures (Run.ts:266) only surface at `Fiber.joinAll` (:328), after the whole call has played.
**Suggestion**: Wrap each `bridge.tick` in `Effect.catchCause(logError)` the way partials do (:237), or make the Bridge publish failures as events instead of failing the caller.

### 8. [warning] Background jobs are forked inside a step that can still fail, leaving orphaned jobs and duplicate task ids
**Location**: src/Bridge.ts:422-424 (`yield* job` inside `hear`), :324-325, :334-335; :433 (`source.run`), :187 (`writer.write`)
**Finding**: `confirmClaim`/`answerRequest` fork the job (`forkIn(scope)`) immediately, but the state change (`agent: "checking"`, `tasks + 1`) is only committed at :493. If anything after the fork fails (`source.run` :433, `writer.write` :187), the Ref keeps the old state: the item is still `pending` and `tasks` is not incremented.
**Evidence**: The next `hear` dispatches the same item again with the *same task number*, and two Investigator jobs run for one claim. Their results are both applied by `L.find`. In the demo they type "Task N" twice into the agent, and `AgentTerminal.waiting` is keyed by task number (Agent.ts:152, :185). This contradicts "all call state is one Ref ... never interleave": the side effect escapes the transaction.
**Suggestion**: Collect jobs as data in the step's return value and fork them only after `commit` succeeds.

### 9. [warning] The Bridge has no timeout of its own; the timeout lives in one Investigator implementation
**Location**: src/Investigator.ts:130-131 (doc: "the Bridge falls back to it when the agent fails or takes too long"); src/Bridge.ts:208-225; demo/Agent.ts:149-168
**Finding**: `background` applies no timeout. Only `AgentTerminal.submit` times out, and only after it gets the `one` semaphore and finishes typing. Time spent queued behind earlier jobs (each up to `timeoutS` plus 6 s of `settle`) is unbounded.
**Evidence**: Any other Investigator that hangs leaves an item stuck in `checking` (never raised) or a request stuck in `checking`, the same stuck state as Finding 3. In the demo, an answer queued behind a slow confirm can take more than 2 × 60 s, after which "answered" is stale. The documented contract ("the Bridge falls back ... takes too long") isn't implemented where it says.
**Suggestion**: Wrap `job` in `Effect.timeout` in `background`, with the Bridge owning the budget. Drop or shorten the per-implementation timeout.

### 10. [warning] Speech flows unfiltered into a shell-capable agent that holds the AWS credentials; report endpoint has no authentication
**Location**: demo/Agent.ts:67-74, :102-109, :132-141; demo/server.ts:538-542, :555
**Finding**: (a) `item.claim` and `question.text` come from what was said on the call (or from Transcribe). They are typed into a pty running a bash-capable agent. That agent's env spreads `process.env`, which includes `AWS_BEARER_TOKEN_BEDROCK` and any real AWS credentials loaded from .env. A spoken "ignore that and run ..." is a prompt injection into a shell. (b) `/agent/report` takes any POST, and the server binds every interface (`listen(port)` with no host). Task ids are sequential, so anyone who can reach the port can supply the `fact`/`answer` Egg Head reads out.
**Evidence**: The path is input → `LedgerItem.claim` (Bridge.ts:443) → `confirmPrompt` → `proc.write`. For the report endpoint: POST `{kind:"answer",task:N,answer:"..."}` → `agent.report` → Deferred → `C.answerLine` → spoken.
**Suggestion**: Bind to 127.0.0.1, add a per-run token to `EGGHEAD_REPORT_URL`, and pass the agent a minimal env (PATH, HOME, the Bedrock token only).

### 11. [warning] Partial-transcript bookkeeping lives outside the Ref and is never cleared
**Location**: src/Bridge.ts:517-530
**Finding**: `asked` is a module-closure `Map`, not part of `BridgeState`. It is written before the Decider call, so when the Decider fails, the key is recorded anyway and the next attempt needs two more words. It is never pruned.
**Evidence**: This contradicts the stated design that "all call state is one Ref". It is invisible to `state`/the dashboard, and the dedup can't be reasoned about like the rest of the state.
**Suggestion**: Move it into `BridgeState` (e.g. `partialAsked: { turn, resource, words }`), reset it on each `hear`, and update it only after the Decider succeeds.

### 12. [warning] Structure: agent mode is threaded through `hear` as scattered `agentMode` branches; Bridge.ts doubled to 575 lines
**Location**: src/Bridge.ts:161, :185, :190, :349-354, :372, :375, :385, :391, :408, :451, :460-490, :503-514
**Finding**: The old linear `hear` now has agent-only conditionals at eight points, two `as C.TurnAnswers` casts (:385, :461) because `gateAnswers` is a union of two question sets, and agent-only optional fields on `Event`, `BridgeState` and `LedgerItem`. Request lifecycle logic is split between `hear` (:460-490), `converse` (:300-345) and `dropOpen` (:496). The two "take the request" branches in `converse` (:324-331 and :334-341) are copy-paste with a different ack line.
**Evidence**: This is the "bolted-on" and "scattered feature checks" pattern the code-quality lens flags. Parity holds today only because every branch was guarded by hand. The next feature has to repeat that guarding.
**Suggestion (code judo)**: Keep the core `hear` pipeline (route → check → ledger → gate) exactly as before and add a single optional `Policy` hook: `{ questions, onHeard(s, ev, answers, routed), onStep(s, ev, silence) }`. The no-Investigator policy is a no-op; the agent policy lives in its own module (`Agent.ts`/`Conversation.ts`) with its own typed answers, so there are no casts. Fold the two take-request branches into one `take(req, line, note)` helper. Also, `floorOpen` (:296-297) re-implements `G.decide`'s min_silence/floor_open rules; reuse the Gate's logic instead.

### 13. [nit] Dead condition and lossy event fields
**Location**: src/Bridge.ts:318-319; :409-427
**Finding**: `silenceS >= 0.8` sits inside the `silenceS >= 1.0` branch, so it is always true. In the pending loop, several items handled in one `hear` overwrite each other's `ev.claim`/`ev.note`/`ev.agent`. Only the last dispatch or skip shows on the dashboard.
**Suggestion**: Remove the dead check. Emit one note per item, or make `agent` an array.

### 14. [nit] The answer fallback runs the same call twice when the Investigator is `direct`
**Location**: src/Bridge.ts:268, :214
**Finding**: With `Investigator.direct` (the tests), the job and its fallback are the same `direct(source).answer`, so a failure is retried with identical input. The `onNone: "direct"` branch at :214 can't happen, because `background` only runs with an Investigator.

