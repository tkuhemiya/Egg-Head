# Agent mode review, 23 Oct 2026

An adversarial review of agent mode (`git diff 3fe7ca1..7dd7885 -- src demo`). It used the pstack `interrogate` method with two reviewers on different models (Opus, Sonnet). It was cross-checked against the TLA+ model in [`spec/Bridge.tla`](../../spec/Bridge.tla) (`spec/check.sh`). A finding is listed as *Act on* only when a concrete path through the code was traced. These are findings, not fixes. Each is replayed as a failing test before it is fixed.

## Intent under review

Egg Head decides when an AI participant on a voice call should speak. Agent mode adds an Investigator.

- A contradicted claim that survives one turn gets a second look before the gate may raise it. A claim the call corrects costs no model call, and Egg Head never interrupts on an unconfirmed fast-check result.
- Egg Head answers when it is spoken to, once the speaker has finished.
- It takes a question that nobody on the call answers within 2.5 s.
- It barges in when someone is about to act on a resource with an open wrong claim.
- Without an Investigator, behaviour is unchanged.

## Act on

| # | Finding | Raised by | Path |
|---|---|---|---|
| 1 | Barge-in speaks claims that nobody confirmed. It can also speak claims the call already corrected, or ones the agent would find right. It runs with no Investigator too. | Opus, Sonnet, TLC (`NeverSaysUnconfirmed`, `NeverSaysCorrected`, `NeverSaysRightClaimIsWrong`) | `partial` takes any open item (`Bridge.ts:524`). `demo/Run.ts` calls `partial` in every text-mode run. |
| 2 | "On it" is never answered when the agent and the direct fallback both fail. The request stays `checking` forever. | Opus, Sonnet, TLC (`AckIsAnswered`) | The fallback fails when the question names no resource (`Investigator.ts` direct `answer`), then `catchCause(logError)` (`Bridge.ts:223`). `pending` never reaches 0. |
| 3 | A failed or timed-out second look counts as a confirmation. | Opus, Sonnet | The confirm fallback returns the fast check's own status (`Bridge.ts:230`), so `compare` contradicts again and the item becomes `confirmed`. |
| 4 | Investigator jobs are forked before the state that records them is committed. A later failure in the same `hear` leaves a running job, with the item still `pending` and the same task number to reuse. | Opus, Sonnet | `yield* job` (`Bridge.ts:423`, `325`, `335`) runs before `commit` (`Bridge.ts:493`). |
| 5 | In agent mode, a later true claim no longer repairs an earlier wrong one. `supportsOpen` is also not tied to the item being gated. | Opus, Sonnet | The second-look loop passes `laterClaimSupportsCheck: false` (`Bridge.ts:416`) before the line is routed. `decide` gates a different item from the one `supportsOpen` matched. |
| 6 | A confirmed claim on a parked topic never resolves. It blocks every later confirmed claim and keeps `pending` above 0. Parking also applies to every open claim, not just the parked topic. | Opus, TLC (`ConfirmedIsResolved`), explorer | `costLevel` returns 1 for any parking phrase in later turns (`Gate.ts:101`). `gateItem` always picks the oldest confirmed claim. |
| 7 | Egg Head's own speech does not count as Egg Head speaking. Acks and answers do not set `lastSpokeS`, and the runner keeps counting silence while Egg Head's clip plays, so lines can come back to back. | Opus, Sonnet | `converse` (`Bridge.ts:300-345`). `demo/Run.ts` ticker. |
| 8 | One error ends the silence ticker for the rest of the call. A failed `hear` leaves its turn in `turns` with no event. | Opus, Sonnet | The `demo/Run.ts` ticker has no catch. `hear` appends the turn first (`Bridge.ts:363`). |
| 9 | The Bridge has no deadline of its own for Investigator jobs. Queue time behind earlier jobs is unbounded, and `settle` adds up to 6 s to every result. | Opus, Sonnet | `background` (`Bridge.ts:208`). `AgentTerminal.submit` (`demo/Agent.ts:149-168`). |
| 10 | Demo security, three parts. The server listens on every interface with no auth, so anyone who can reach it can supply what Egg Head says (`/agent/report`). Call speech is typed raw into a shell agent whose environment holds the AWS credentials. Task ids restart each run while the agent terminal persists, so a stale report can answer a new task. | Opus, Sonnet | `demo/server.ts` `listen(port)`. `demo/Agent.ts` spawn env and `type`. |
| 11 | `commit` can be interrupted between `Ref.set` and `PubSub.publish`. A barge-in can then mark a claim raised without the line ever being voiced. | Sonnet | `demo/Run.ts` interrupts the partials fiber when a line ends. |

## Consider

- **Agent mode is threaded through `hear` as scattered `agentMode` branches** (Opus, Sonnet). A per-mode policy or a request reducer would remove the casts and duplicated branches. The fixes above touch most of this code, so the structure is reconsidered when they are designed.
- **Slow calls run under the one lock** (Sonnet, explorers). Decider, the check, Bedrock and the writer all hold the lock, so a partial or a tick waits behind them and acts on stale silence. This is taken up in the latency work.
- **The gate is looser than the research.** It needs 1 turn before speaking where the research found 3, and its prompt includes the silence line that exp 7 found lowers `finished` AUC. This is taken up in the research work.
- **`asked` lives outside the state Ref** (Opus, Sonnet). Fix it when `partial` is changed.

## Noted

- A dead `silenceS >= 0.8` check inside a `>= 1.0` branch.
- Several items in one `hear` overwrite each other's `ev.claim` and `ev.note`.
- The `failed` and `skipped` `AgentNote` actions are never produced.
- `floorOpen` repeats the gate's silence rule.
- The agent's spoken fact has no length clamp.
- Agent `ms` includes `settle`.

## Dismissed

None. Both reviewers traced their findings to code paths, and the model checker or a second reviewer confirmed the critical ones.

## Agreement

Both models independently raised findings 1 to 5 and 7 to 10. The TLA+ model, written separately, breaks the rules behind 1, 2 and 6. Where one model alone raised a finding (Sonnet on 11 and on task ids, Opus on parking), the path was checked by reading the code.
