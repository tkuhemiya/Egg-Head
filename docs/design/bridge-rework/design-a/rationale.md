# Design A: Bridge as gather / reduce / interpret

## Problem

`Bridge.hear` is a 130-line function that holds one Semaphore while it calls Decider, runs checks, calls Bedrock, forks Investigator jobs and mutates a record by `agentMode` branches. Eleven review findings and five failing TLA+ rules all trace to four causes: lifecycles are implicit (booleans and phases inside `LedgerItem` and `Request`), effects happen before the state that records them is committed, Egg Head's own speech is invisible to the Bridge, and slow calls share one lock with everything. Constraints I honour: `Gate.decide` thresholds and `GateDecision` shape; the same Decider batches (so `ScriptedDecider` fixtures and the ten Bridge traces replay); the harness (`Call.ts`, `Judge.ts`) reads only typed Event fields; three language judgments sit behind a seam until W5; the owner's four decisions; and the coordinator's addition that an Investigator may answer "unknown".

## Usage (caller's view)

The loop and tests keep their API. One new call: the caller says when Egg Head's line ended.

```ts
// src/Call.ts (see src/Call.ts in this folder)
const clip = yield* sound.speak(voice, ev.speech.value.text)
yield* Effect.sleep(clip.durationS).pipe(Effect.andThen(bridge.spoke(ev.speech.value.id, "finished")), Effect.forkScoped)

// test: the judge asks typed questions, not words
const ev = Option.getOrThrow(yield* bridge.partial("Priya", "Jordan, restart the payments API now"))
assert.equal(ev.speech.value.kind, "barge"); assert.equal(ev.speech.value.certainty, "tentative")
assert.equal(ev.speech.value.basis.value, "fastCheck")
assert.isTrue(ev.moves.some((m) => m._tag === "Dispatched" && m.kind === "confirm"))   // "I'm double-checking" is a real job

// demo/server.ts: nothing speaking-related. Layer wiring is unchanged; Policy comes from Option<Investigator>.
```
`hear`, `tick`, `partial`, `run`, `state`, `pending`, `changes` keep their signatures. `Event.said` and `saidKind` become `Event.speech`; `agent`/`request`/`claim`/`note` become `moves` (migration list under Event).

## Shape

**Three beats, one pure core.** `Gather` (slow, no lock, against an immutable snapshot) produces `Evidence`; `Step.reduce(state, input, ctx)` (pure, total, microseconds) produces `Transition = {state, event, commands}`; the shell commits with one `Ref.modify` and then interprets commands. `reduce` cannot await a model, so nothing slow can run under the commit. `Command`s exist only inside a committed `Transition` (a class with a private constructor), so a job cannot be forked before its record is written (finding 4) and a failed `hear` cannot leave a ghost job. Event and state are appended in the same modify and published in an uninterruptible block (finding 11).

**Lifecycles are state machines with tagged phases** (`model-the-domain`):
- Claim: `Fresh -> Checking{job} -> Standing{basis,voice} -> Closed{Spoken|Corrected|Overruled|Parked|Undetermined|Unverifiable}`. Direct mode is born `Standing{fastCheck, firm}`; the other phases are simply unreachable, so there is no `if (agentMode)` in the machine. `Standing{basis:"confirmed"}` is built in exactly one function from a `Checked` report of a primary job, so a failed look can never count as a confirmation (finding 3).
- Request: `Listening -> Working{job} -> Ready{Found|Unable} -> Closed`. Entering `Working` is the ack. The job layer is total, so `Working` always reaches `Ready`.
- Job: `Running -> Finished{outcome}`, the only edge. Every Running job carries a Bridge-owned `deadlineAt` (from dispatch, so queue time counts) enforced by the reducer on every input and by a timer fibre. Fallback is data: a failed or timed-out primary job starts a `via:"direct"` job (a `recheck` for claims); a failed second try closes the subject.
- Floor: `Open -> Composing -> Speaking -> Open`, driven by `SpeechEnded` from the caller, with a Bridge-owned `maxSpeechS` so a silent caller cannot wedge it.

**"Unknown" (coordinator addition).** `Report = Checked | Answered | Unknown`. `Unknown` is a successful report, distinct from `Failed`/`TimedOut` (which trigger the direct fallback). For a claim: `Closed{Undetermined}`, no speech, a `Closed` move with a dashboard note (if Egg Head had already barged tentatively, a retraction is owed, see below). For a question: `Ready{Unable "unknown"}`, spoken as "I couldn't find that out, Priya". The direct investigator also returns `Unknown` instead of failing when the question names no resource (the cause of finding 2).

**Owner decisions as types.**
1. Barge: `Claims.bargeable` admits Fresh, Checking, Standing and never Closed (a corrected claim is Closed, so it cannot be bargeed by construction). `bargeVoice` is `firm` only for `Standing{confirmed}`, else `doubleChecking`, and `Claims.spoken` starts the confirm job in the same transition when none runs. A tentative barge therefore always has a job (law `TentativeIsChecked`). Barge needs `analysing == 0` (never act before the previous line is understood). **Proposal: barge-in only with an Investigator** (`Policy.barge`): the tentative wording promises a check, and only an Investigator can keep it. Today's barge without an Investigator is itself finding 1.
2. Failed look: the recheck job above; still wrong -> `Standing{fastCheck, couldNotConfirm}` -> tentative flag at a gap; right -> Overruled; Unknown/failed -> quiet.
3. One line per gap: `Floor.mayStart` (phase Open and a human line since, or `quietAfterSpeechS` after it ended). Silence is `min(reported, now - lastEndedAt)`, so the runner's counter running during Egg Head's clip no longer counts. Cooldown stays in `Gate`, fed by `lastUnpromptedAt`, consulted only for Flag; Answer/Ack/Take never read it.
4. Parking: a per-claim `Parks` verdict closes only that claim. `Gate.costLevel` loses its global regex. Every Standing claim is gated, so a blocked claim no longer hides the ones behind it (finding 6).

**The seam** (`Judgments`, a `Context.Reference` like `Tuning`). `judge(queries, lines, lineAnswers, lineFacts) -> Verdict[]` with `Corrects | Parks | Answers`. `today` is the current rule unchanged except two things: the later-true-claim signal is matched per claim by check+resource (finding 5) and parking is scoped to the resource named (decision 4; a parking line naming no resource parks the newest open claim, "park that"). Thresholds stay in the reducer. W5 replaces the Layer.

**Egg Head's speech is an input.** `Event.speech.id` goes to the caller; `Bridge.spoke(id)` comes back. Unknown or repeated ids are ignored.

**No `agentMode` branches.** `Policy {secondLook, conversation, barge}` is data read at three named places (claim birth, request intake, barge eligibility), and `Gather` picks the Decider batch from it. The 130-line `hear` is `LineBegan`, gather, `LineUnderstood`; `LineUnderstood` is seven slice calls (see `Step.ts`).

**Locking and latency.** There is no state lock. Only `hear` is serialized (the hear lane), because line n+1's meaning depends on n; gather runs inside the lane, but `tick`, `partial`, job results and speech reports never wait for it. Ticks that arrive while a line is being understood (`analysing > 0`) are held, not acted on with stale silence. The writer runs after the decision commit, outside any lock; the originating call awaits only its own compose. For W7: relax the lane to ordered commit with parallel gather; Evidence is id-keyed and `reduce` idempotent, so only the lane changes.

**Event for the judge** (`src/Event.ts`). `speech{id, kind, certainty, basis, toward, about, text}`; `moves[]` of `Opened | Dispatched{kind: confirm|recheck|answer, via} | Reported{end: found|unknown|failed|timedOut|cancelled} | Closed{why, resource} | Requested | Held | Note`; dense `seq`. Judge reads certainty, basis, a recheck job (`Dispatched kind=recheck`), and `Closed{why:"parked", resource}`, never words. Migration: `Judge.observe`, `Call.onEvent`, the page and dashboard JS (`ev.said` -> `ev.speech.text`), `test/Bridge.test.ts` and `Parity.test.ts` (read `speech` instead of `said`). `Expect` adds `Says.certainty/basis`, `Investigates` gains `recheck`, `Closes{resource}`, `SaidKind` gains `retract`.

**TLA+ in step with code.** `Laws.ts` has each rule as a predicate with the same name; `test/Laws.test.ts` explores the real reducer to depth 6 over the TLA's nondeterminism (a TS bounded model-check of the code, not of a hand copy) and drains for the liveness rules. A spec-sync test parses the header table in `spec/Bridge.tla` and fails unless it equals `Claims.Phase`/`Floor.Phase`/`Input` tags. Revised rules in `spec/Bridge.rules.tla`: `NeverSaysUnconfirmed` becomes `NeverFirmOnUnconfirmed`; tentative on unconfirmed is allowed; never any speech about a corrected claim; `NeverSaysRightClaimIsWrong` is firm-only; new `TentativeIsChecked`, `ParkingIsScoped`, `OneLinePerGap`; `AckIsAnswered` and `ConfirmedIsResolved` hold because Answer is total, parked claims close, and every claim is gated.

**Parity.** Direct mode: same Decider batches, same Gate thresholds, same ordering (second look before observe, converse before gate). Differences are intentional and called out: (a) parking scope; (b) barge-in off without an Investigator; (c) `Event` shape. `Gate.decide` input changes (verdicts, not text), so `gate-parity.json` is handled in the test adapter: `fromPython` builds `correctedBy` and `parked` with `Judgments.today`'s pure rule functions over `later_turns`, then calls `Gate.decide`; the 16 snippets and 20k grid must still match the Python, which proves the refactor. The scoped-parking behaviour is not expressible in the single-claim Python oracle, so it gets unit tests. To move the oracle deliberately: add a `parked` argument to `cost_level` in `spike/egghead_gate.py`, run `python3 spike/gate_eval.py` (must print REPORT-gate.md numbers) then `python3 spike/export_gate_parity.py`, and say so in the commit. Bridge traces: expected unchanged if none holds two open claims with a parking line; if one does, regenerate it and say why.

### What each finding becomes

| # | Finding | Under this design |
|---|---|---|
| 1 | barge on unconfirmed/corrected/right | `bargeable` excludes Closed; unconfirmed is tentative with a job; right claim only ever tentative, retraction owed; off without an Investigator |
| 2 | "On it" never answered | Job layer total; direct returns Unknown not error; `Ready{Unable}` always spoken |
| 3 | failed look = confirmation | Failed -> direct recheck -> `Standing{fastCheck, couldNotConfirm}`; `confirmed` only from a primary Checked |
| 4 | job before commit | Commands only from a committed Transition; job id and row allocated in the same reduce |
| 5 | later true claim no longer repairs | per-claim `ledger` verdict in `Judgments.today`, both modes; `supportsOpen` deleted |
| 6 | parked claim blocks | per-claim Parks closes it; every Standing claim is gated |
| 7 | own speech / back-to-back | Floor machine, `spoke`, `Floor.silence`, one line per gap |
| 8 | ticker death / failed hear | `LineFailed` gives the turn a terminal event, releases `analysing`; reduce is total; ticker catches per tick |
| 9 | job deadline | Bridge-owned `deadlineAt` from dispatch, swept in reduce and by timer; `settle` is the terminal's concern, `ms` measured by the Bridge |
| 10 | demo security | Out of Bridge scope (localhost bind, sanitised input already landed b629bba); the Bridge adds epoch-scoped JobIds and idempotent `JobDone` so stale reports are inert |
| 11 | commit not atomic | one `Ref.modify` + uninterruptible publish; `seq` lets a consumer detect a gap |
| C1 | `agentMode` branches | `Policy` data, three read sites |
| C2 | slow calls under the lock | no state lock; hear lane only |
| C3 | gate looser than research | untouched (research workstream) |
| C4 | `asked` outside Ref | `state.partials` |
| Noted | dead check, overwritten `ev.claim/note`, unused AgentNote actions, duplicated floorOpen, fact clamp, `ms` incl. settle | `moves[]`; `Reported.end` produces failed/timedOut/cancelled; `Gate.gapOpen` shared; clamp at Report decode; `ms` from dispatch |

## Synthesis decision

Left open: see docs/handoff/continue.md for the synthesis step.

## Tradeoffs accepted

- We accept a larger file count (about 12 new modules) in exchange for each machine being readable and model-checkable alone. Each is 40 to 100 lines.
- We accept that `hear` is still serialized in its lane, in exchange for straight-line gather and ordered transcript semantics; W7 relaxes it.
- We accept two Events being merged into one (the draft is held in `Floor.Composing` until composed) so one input yields one event; the cost is that a slow writer delays publication, as today.
- We accept an `Event` shape break (`said` -> `speech`) in exchange for one source of truth the Judge can read.
- We accept `retract` as a new SaidKind: tentatively accusing someone and never taking it back is worse than the extra line.
- We accept barge-in being off without an Investigator, a deliberate deviation from "unchanged" because it is finding 1.
- We accept that a caller who never calls `spoke` degrades to `maxSpeechS` spacing rather than failing.

## Alternatives considered

- **Keep imperative `hear`, extract helpers, add per-concern mutexes.** Smaller diff, but invariants (confirmed-only, job-after-commit, terminal jobs) stay conventions; callers still coordinate several functions; shallow.
- **Actor per claim/request (fibre each, mailbox).** Natural concurrency, but cross-claim rules (one line per gap, oldest first, parking by resource) need a coordinator anyway, and order-dependent behaviour is not model-checkable by enumeration.
- **Full Elm: every await (route, check, judge) an Input.** Maximal concurrency and no hear lane, but a line's understanding becomes a 4-stage pipeline in state and `hear` loses its straight-line return. Left as the W7 direction; this design does not preclude it.
- **A statechart library / XState.** Heavier dependency; Effect `Schema` unions plus pure functions already give exhaustiveness.
- **Give Decider the whole state and ask "what now?"** Rejected by research (exp 3, jevbench).

## Open questions and risks

- Is "a parking line naming no resource parks the newest open claim" right, or should anaphora wait for the scoped Decider question (W5)?
- Is dropping barge-in without an Investigator acceptable, or should `Investigator.direct` be wired by default so barge stays on everywhere?
- Should a tentative barge later overruled produce a spoken retraction (as designed), or only a dashboard note?
- On a writer failure the design speaks the code line instead of failing `hear`; is silent-failure-to-code-line acceptable for Bedrock outages?
- `Event.said` removal touches the page JS; do we want a one-release `said` alias?
- The hear lane still serializes line analysis across a slow Bedrock escalation; is that acceptable until W7?
- What `quietAfterSpeechS` ("a few seconds") does the owner want: 3 s assumed.

## Next implementation step

Add `Ids.ts`, `Jobs.ts`, `Floor.ts` and `Claims.ts` with the Laws exploration test, port `Bridge.hear` onto `reduce` for direct mode first, and prove the ten parity traces still replay before adding the Investigator phases.
