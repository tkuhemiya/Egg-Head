# Explorer: the Bridge core (hear, tick, partial, jobs, lock)

_A delegated report from 23 Oct 2026, kept as written. Line numbers are at the commit it names or at 7dd7885 (before this PR). Treat claims as findings, checked where docs/handoff/continue.md says so._

## Bridge core: how Egg Head decides to stay quiet, investigate, speak, reply, take a question or barge in

Everything below is from reading the code. I did not run anything. The timeouts, `Run.ts`, `Agent.ts` and `Bedrock.ts` sections were read less deeply than `Bridge.ts`, which I read line by line.

### Components Found
- **`Bridge`** (`/home/user/Egg-Head/src/Bridge.ts:130`): a service exposing `hear`, `tick`, `partial`, `run`, `state`, `pending` and `changes`. `Bridge.make` (line 146) builds the whole subsystem.
- **State** (Bridge.ts:153-155):
  - A `Ref<BridgeState>` holds `turns`, `ledger`, `events`, `escalations`, `lastSpokeS`, `gateSignals`, `requests`, `tasks`, `finishedP` and `notes`.
  - `lock = Semaphore.make(1)` serialises everything that touches it.
  - `pubsub = PubSub.unbounded<Event>` carries decisions to subscribers.
- **`asked`** (Bridge.ts:518): a plain mutable `Map` closed over by `partial`, outside the Ref and outside the lock's protection. It records which (line, resource) pairs a partial already asked Decider about.
- **`Ledger`** (`src/Ledger.ts`): immutable claim items with `raised` and an agent state of `pending`, `checking`, `confirmed`, `overruled` or `skipped`.
  - `add` ignores a new claim with the same check and resource as an open one.
  - `markRaised` matches by object identity (`i === item`).
  - `update` and `find` match by claim turn plus check and resource.
- **`Gate`** (`src/Gate.ts`): pure `decide`. Speak requires all six reasons to hold, in this order: persisted, not_repaired, min_silence (0.5 s), floor_open (P(finished) ≥ 0.5 or 1.2 s silence), worth_it (cost ≥ 2) and cooldown (30 s).
  - Repair comes from a later supporting claim ("ledger"), a repair keyword ("keyword") or Decider `selfRepairedP ≥ 0.45` ("decider").
- **`Conversation`** (`src/Conversation.ts`):
  - Thresholds: `T_ADDRESSED` 0.25, `T_ASKS` 0.3, `T_DIRECTIVE` 0.3, `REPLY_MAX_WAIT_S` 4.0, `OPEN_SILENCE_S` 2.5.
  - Helpers: `readyToReply`, `trailsOff`, `namesEggHead` and the spoken-line builders (`flagLine`, `ackLine`, `bargeLine`, `answerLine`).
  - The `Request` state machine runs `listening`, `checking`, `ready`, then `answered` or `dropped`.
- **`Investigator`** (`src/Investigator.ts`): `confirm(task, item)` and `answer(task, question)`.
  - `direct(source)` answers from `CheckSource` with no model.
  - The agent-backed version lives in `demo/Agent.ts` (`AgentTerminal.submit`, which owns the timeout).
- **`Writer`** (`src/Speaker.ts`): turns a ledger item into a spoken line.
  - The template writer is a pure function. The Bedrock writer (`src/Bedrock.ts:151`) calls an LLM and has no timeout.
  - `Escalator.route` is the other Bedrock call, used when the router says "escalate".
- **`CheckSource`/`MockSource`** (`src/Checks.ts`): `run` reads a `Ref`, so a check reflects the world at call time. `MockSource.inject` mutates it.

### Flow

**`hear`** (Bridge.ts:361-494), entire body under `lock.withPermits(1)`:
1. Line 363: `Ref.updateAndGet` appends the turn immediately. This is the first write, and `events` is not touched until `commit`.
2. Lines 365-373: build the window (last 12 turns) and `openItems = L.open(ledger)`, then fetch the inventory. In parallel (`concurrency: "unbounded"`):
   - `route(window, inventory)` (the Router, Decider calls);
   - the gate questions `askGate` only if some claim is open (non-agent mode);
   - in agent mode, `askTurn` (rep, fin, addr, ask) every time.
3. Lines 374-393:
   - `finishedP` is updated whenever the gate was asked. In non-agent mode that means only while a claim is open.
   - `gateSignals` is updated only if `openItems.length > 0`.
   - The event is seeded with `deciderMs`, from `Clock` via `Effect.timed`.
4. Lines 396-405: if the route is "escalate", increment `escalations` and call `escalator.route(window)` (Bedrock, inside the lock).
5. Lines 408-428 (agent mode): for each open item with `agent === "pending"` and `turn < ev.turn`:
   - If `G.repairedBy` finds a repair, set the item `skipped`/`raised` and add a note. This is the "no LLM call" path.
   - Otherwise `confirmClaim` (lines 228-262) sets the item `agent: "checking"`, `tasks+1`, and returns `job`. `yield* job` forks the background fiber via `forkIn(scope)`, and the dispatched note goes on the event.
6. Lines 430-458: if the route is "check", run `source.run`, then `compare(claimed, status)`.
   - On "contradicts", `L.add` a new item. In agent mode it starts as `pending`.
   - On "supports", `supportsOpen` is true if an open item matches the same check and resource. It is computed against `openItems`, the snapshot from before this turn's additions.
7. Lines 460-490 (agent mode only) update the request state:
   - the same person continuing an addressed request appends text to it;
   - naming Egg Head with `addr ≥ 0.25` creates an `addressed` request;
   - a "?" with `ask ≥ 0.3` and a non-check route creates an `open` request;
   - otherwise a different speaker drops a listening open request.
8. Line 492: `step` runs, then line 493 `commit` does `Ref.set` of state plus the event, then `PubSub.publish`.

**`step`** (Bridge.ts:348): with an Investigator, `converse` first. If it spoke, `step` returns without running the claim gate. Otherwise it falls through to `decide`.

**`converse`** (Bridge.ts:300-345):
- A `ready` answer is spoken when `floorOpen` holds (silence ≥ 0.5 s and (`finishedP ≥ 0.5` or silence ≥ 1.2 s)).
- An `addressed` listening request goes through `readyToReply`, which waits for 4 s of silence, otherwise requires no trailing filler and `finishedP ≥ 0.5`. When ready, it forks `answerRequest`, says "On it, X", and sets `checking`.
- An `open` request is taken after 2.5 s of silence if the last speaker is still the asker. It says "I can check that."
- The `ack` is spoken immediately and the real answer arrives later as a `ready` request.

**`decide`** (Bridge.ts:170-198):
- It picks `gateItem`: the oldest open item, or in agent mode the oldest with `agent === "confirmed"`. It reads `now` from Clock, runs `G.decide` with `signalsOf(s)`, and cooldown = `now - lastSpokeS`.
- If the gate says speak, the line is `flagLine` when `item.fact` is set, otherwise `writer.write(item)` (Bedrock, inside the lock). It then marks the item raised and sets `lastSpokeS = now`.
- If it did not speak but `repairedBy` is set, the item is silently closed (`markRaised`).

**`tick`** (Bridge.ts:499-515), under the lock:
- It returns none if there are no events yet.
- Non-agent: with no open items it returns none, otherwise it runs `decide` with the stale `gateSignals`, `supportsOpen=false` and the new silence. It always emits an event.
- Agent: it runs `step`. An event is emitted only if something was said, noted or requested, or the ledger reference changed.

**`partial`** (Bridge.ts:520-554), under the lock:
- It finds the first open ledger item whose resource is named by `aliasHits(text)`. This uses `L.open` and ignores the `agent` status, so even a `pending` or `checking` item qualifies.
- It dedupes on `turns.length|resource` and re-asks only when the word count rises by 2 or more.
- It asks `directiveQuestions` (Decider) on `[...turns.slice(-12), [speaker, text]]`.
- If `act < 0.3`, it commits a note-only event.
- Otherwise it barges in: `markRaised`, `lastSpokeS = now`, `said = bargeLine`, using `item.fact ?? factOf(item)`. It skips the gate, cooldown and floor checks.

**`background`** (Bridge.ts:208-225), the job lifecycle:
- It runs `job` and, on failure, a `fallback`. It times the whole thing.
- It then takes `lock` and runs `done(Ref.get(state), result, by, ms)` against the current state (not the state at dispatch), then `commit`s a new "(agent)" event.
- `catchCause(logError)` swallows any failure, and `forkIn(scope)` makes the job outlive the `hear` that started it.
- For confirm, the fallback is `Effect.succeed({status: item.status, ...})`, which counts as "still wrong" and confirms the claim. For answer, the fallback is `direct(source).answer`, which can itself fail.

**`run`** (Bridge.ts:556-564): `Stream.mapEffect` over `Utterance` and `Silence` inputs. Within one stream it is sequential. A failed tick or hear fails the stream.

**Where Clock is read:**
- `nowS` at Bridge.ts:157, used in `decide` (174) and `partial` (543);
- `Effect.timed` for `deciderMs`;
- `hear`'s gate silence comes from the caller's `silenceS` argument, not Clock;
- `lastSpokeS` records the moment of decision, not the end of speech;
- every cooldown comparison uses `nowS`, so `TestClock` controls it.

**Callers:** `demo/Run.ts`:
- line 147 `hear`;
- line 192 a ticker fiber (`bridge.tick`);
- line 237 `partial`, once per word, from a separate fiber;
- lines 148-169 `onEvent` subscribes to `changes` and voices anything with `said`, setting a human hold (`humansWaitUntil`).

### Concrete orderings

1. **A report arriving after its timeout fallback.**
   - There is no timeout in the Bridge. The only one is in `demo/Agent.ts:155` (`Effect.timeoutOption(timeoutS)`, default 60 s via `demo/server.ts`). When it fires, the entry is removed from `waiting` and the job fails, so `background` runs the fallback.
   - A late HTTP report then finds no entry and `report` returns `false` (Agent.ts:~183). It is dropped, never delivered.
   - Because `background` produces exactly one result per job, the Bridge cannot receive two results for one job.
   - The timer starts only after `one.withPermits(1)` is acquired (Agent.ts:~149-159). Jobs queued behind another job wait unbounded, and that wait is not counted against the timeout.
   - Fallback semantics differ by job:
     - A `confirm` fallback fails open: the fast-check status is kept, so it confirms and the claim will be spoken.
     - An `answer` fallback is `direct(source).answer`, which fails with `SupportError` if the question names no resource. `catchCause(logError)` then swallows it. The request stays `checking` forever, the caller was already acked "On it", and `pending` stays above 0. That can hold `waitForEggHead` in the demo until its `maxS`.

2. **`partial()` arriving while a `hear()` is in flight.**
   - `partial` blocks on the lock. When it runs, it sees the post-`hear` state, but its text belongs to the line that was in progress when it was called.
   - The `asked` key uses `s.turns.length`, which `hear` has just incremented. The stale partial is therefore treated as belonging to a new line and its dedupe slot is reset.
   - The event it produces has `turn = s.turns.length`, a turn that does not exist yet. `Run.ts onEvent` falls back to `current` for the index.
   - Barge also does not re-check that the open claim is still unraised-and-relevant beyond reading state under the lock. A claim just corrected in the `hear` ahead of it is already marked raised, so it correctly finds nothing.
   - One real hazard: the partial was meant to cut a speaker mid-line, but if `hear` (Decider plus possibly Bedrock) holds the lock for seconds, the barge arrives late. There is no staleness check on the partial's age.

3. **Bedrock writing while the floor is held.**
   - `writer.write` and `escalator.route` both run inside `lock`, with no timeout in the Bridge. The Decider provider timeout is 300 s (`Decider.ts:212`).
   - While Bedrock runs, the following all queue behind the lock: `tick`, `partial`, `hear` and every Investigator result (`background`'s `done`). A Bedrock write that takes several seconds delays barge-ins and the next hear.
   - `lastSpokeS` is set only after the write returns. `commit` happens after the write, but the speech is published after commit and then voiced in `onEvent`, so floor ownership depends on `Run.ts`'s `humansWaitUntil`. The Bridge itself has no notion of "floor held by Egg Head".
   - If `writer.write` fails, the exception propagates out of `hear`/`tick`: no commit, so the item is not marked raised and `lastSpokeS` is unchanged. The turn is already appended (see Non-Obvious Things). In `Run.ts` the ticker does `yield* bridge.tick(...)` with no catch, so a `SupportError` from a tick would end the ticker fiber permanently. This follows from the code but I did not execute it.

4. **Two contradicted claims open at once.**
   - `L.add` dedupes only same check plus resource. Two different resources can both be open.
   - `decide` and `gateItem` gate only one item per step: the oldest open item, or in agent mode the oldest `confirmed` one. A younger claim confirmed earlier than an older one wins the gate in agent mode. An older `checking` item is skipped.
   - Gate inputs (`selfRepairedP`, `interruptP`, `laterTurns`) come from the latest line and are applied to the oldest item. The signals describe repair of "the open claim" generically, not per-claim.
   - After one speaks, the 30 s cooldown blocks the next flag, unless it is a barge, answer or ack, which ignore cooldown.
   - `supportsOpen` is true if any open item matches, so a supporting statement can repair the wrong one when two share a resource, but dedup prevents that.
   - `pending` items that survive a turn are each given a `confirmClaim` in the same `hear`: several forks go out with consecutive task numbers.

### Invariants the code relies on

| Invariant | Enforced? |
|---|---|
| State is only mutated under the lock | Mostly. `hear` writes the turn at line 363 inside the lock, but `asked` (Bridge.ts:518) is outside any Ref. |
| `turns` is append-only and `item.turn` is a stable index | Yes while the lock is held; it breaks if `hear` fails after the append, because the turn stays with no event. |
| One result per job | Yes, by construction of `background`. |
| `tasks` numbers are unique | Not enforced: see Non-Obvious Things. |
| Agent results see the state at report time | Yes. `done` reads `Ref.get` under the lock and guards on `current.raised` / `r.state === "checking"`. |
| Only a confirmed claim reaches the gate | Yes for `decide`; no for `partial`, which accepts any open item. |
| Cooldown applies to every utterance by Egg Head | No. It applies only to claim flags (`decide`). |
| `lastSpokeS` reflects when speech ended | No, it is the decision time. |
| Egg Head never speaks over a live voice | Only for flags and replies (≥ 0.5 s silence, plus the floor check). Barge-in deliberately bypasses it. |
| A request is not left `checking` forever | Not enforced. |

### Files Read
- /home/user/Egg-Head/AGENTS.md (first 80 lines)
- /home/user/Egg-Head/src/Bridge.ts (full)
- /home/user/Egg-Head/src/Speaker.ts, Investigator.ts, Gate.ts, Ledger.ts, Conversation.ts, Compare.ts (full)
- /home/user/Egg-Head/src/Bedrock.ts (lines 120-195, plus a grep)
- /home/user/Egg-Head/src/Checks.ts (lines 50-86)
- /home/user/Egg-Head/demo/Agent.ts (lines 100-200)
- /home/user/Egg-Head/demo/Run.ts (lines 135-260)
- Grep only: `src/Decider.ts`, `src/Router.ts`, `demo/server.ts`

### Boundaries
- **Inputs:**
  - `hear(speaker, text, silenceS)`: final transcript segments, with silence supplied by the caller.
  - `tick(silenceS)` from VAD.
  - `partial(speaker, text)`.
  - `run(Stream<CallInput>)`.
  - Layers: `CheckSource`, `Writer`, `DecisionModel`, and optionally `Escalator` and `Investigator`.
- **Outputs:**
  - `Event` records (return values, plus `PubSub` via `changes`).
  - `state`, and `pending` (a count of Investigator jobs in flight plus requests waiting on a reply).
  - `said`/`saidKind` is the only speech output. The caller does the voicing and the floor hold.
  - The lock is also taken by background Investigator results.

### Non-Obvious Things
- **Forking before commit loses state on failure.** `confirmClaim` and `answerRequest` fork the background fiber (`yield* job`) before `hear` commits. If `step` or `writer.write` fails after the fork, the fiber still runs, but the `tasks` bump and the item's `checking` mark are lost (they were only in the local `s`).
  - The next `hear` sees the claim still `pending` and dispatches a duplicate job with the same task number.
  - `AgentTerminal.submit` keys its `waiting` map by task number, so a duplicate overwrites the first entry.
- **`partial` and `tick` can fail after the turn is appended.** `hear` appends the turn first (line 363) and commits later. A Decider error mid-`hear` leaves the turn in `turns` with no event, shifting later `ev.turn` indices relative to `events`.
- **Stale gate signals reach new claims.**
  - `gateSignals` is only refreshed when a claim was already open before the turn. A claim added in the current step uses signals left over from an earlier turn, or defaults of `selfRepairedP=0` and `interruptP=0.5` if there were none.
  - `finishedP`, in contrast, updates on every turn in agent mode.
  - Ticks reuse those stored signals by design, so a long silence is judged on the last utterance's answers.
- **`lastSpokeS` is the start of the decision, not the end of speech.** Acks, answers and barge-in lines interact with it unevenly: barge sets it, acks and answers do not.
- **Barge-in ignores confirmation.** It can interrupt about a claim that is still `pending` or `checking` (not yet second-looked), and if the Investigator later overrules the claim, the barge has already been said. `background`'s `done` handles a raised item by only adding a note ("Already raised or corrected...").
- **`tick` in agent mode reports a change by ledger reference.** `next.ledger !== s.ledger` is true whenever `markRaised` ran, because it always builds a new array.
- **`changes` has no replay.** `PubSub.unbounded` with `Stream.fromPubSub` loses events published before subscription. `Run.ts` subscribes with `forkScoped` followed by `yieldNow`, which is a timing assumption, not a guarantee.
- **The timeout is not in the Bridge.** Without a timeout in the supplied Investigator, a hung job leaves its item `checking` or its request `checking` forever.
- **Task numbers come from `s.tasks`.** The state is cloned per step, so two jobs dispatched in one step are numbered correctly, but only if the step commits.
- **Overrule marks the item `raised: true`.** After an agent says the claim was right, the item is closed and will not be re-checked.

### Open Questions
- `Router.route` and `Questions.ts` internals (what `alias`/`aliasHits` match, how long a route takes) were not read. I only know they run inside the lock.
- I did not read `Decider.ts` beyond a grep, so I do not know its retry/429 behaviour. Its 300 s default timeout is the only bound on a Decider call inside the lock.
- I did not read `demo/Run.ts` end to end, so I cannot say how `silenceS` is computed for `hear` or what `TICK_MS` is.
- I did not trace the agent-side `investigator` layer beyond `submit`. Its `confirm`/`answer` wrappers and the "wrong report kind" error path are unread.
- Whether a `SupportError` from `tick` really stops the ticker fiber is inferred from the missing `catch` in `Run.ts`; I did not run it.
- The tests were not read, so I do not know which of these orderings are covered. `test/Conversation.test.ts` is the first place to check.
