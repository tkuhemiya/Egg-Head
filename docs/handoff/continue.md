# Continue this PR

This brief is for whoever picks up branch `claude/fervent-fermat-c78gg1` (PR #11). It says what is done, what is left, and how to do the rest at the same standard. Work that needs the hosted Decider, OpenRouter or AWS is described in [`blocked-work.md`](blocked-work.md). This file covers everything else.

## Read first, in this order

1. `AGENTS.md` and `README.md`: the project. Egg Head decides **when a voice agent on a multi-party call speaks**. The incident call is only a demo of that, so don't over-fit to it.
2. [`docs/design/architecture.md`](../design/architecture.md): how the Bridge, Router, Gate, Conversation, agent and demo fit together, with every concurrency and timing hazard found.
3. [`docs/reviews/2026-10-23-agent-mode.md`](../reviews/2026-10-23-agent-mode.md): the 11 findings to fix. Finding 10, demo security, is already fixed.
4. [`docs/decisions/quality-run.tsv`](../decisions/quality-run.tsv): every decision so far, with its reason and evidence. The four `direction` rows are the owner's product decisions, and they are binding.
5. [`docs/design/behaviour-harness.md`](../design/behaviour-harness.md) and [`docs/design/decider-on-state.md`](../design/decider-on-state.md).
6. `spec/Bridge.tla` and `spec/check.sh`: the TLA+ model of when Egg Head speaks. Today it fails all five rules, which is expected until W3 lands.

## How the work has been done (keep doing it this way)

- **Prove it, don't claim it.** Each change ends with a check that has been shown to fail when the change is broken. Reports say VERIFIED, NOT VERIFIED or INCONCLUSIVE, and INCONCLUSIVE is never reported as a pass.
- **Failing test first.** Commit the repro (a scenario line, a unit test or a TLC counterexample turned into a test) before the fix.
- **One finding per commit,** each with its own evidence.
- **Log decisions.** Append one row per decision to `docs/decisions/quality-run.tsv`. The columns are `ts phase decision why evidence result`, tab-separated, one line per row, with evidence as a pointer (commit, file:line or command) and never prose. The log is append-only: fix a wrong row with a new row.
- **Design big changes twice.** For a change that crosses module boundaries, sketch two different designs, have a third party compare them against a written rubric, pick a base, and graft the best parts of the other in.
- **Numbers carry their evidence.** Give the run count, the spread and what limits the result. Never tune on held-out data.
- **Ask the owner only real product questions,** and offer a recommended option. Decide engineering questions yourself and log them.
- **Checks to run before every push:**

  ```bash
  npm run check && npm test                         # 105 tests at handoff
  spec/check.sh                                     # TLA+ rules (downloads tla2tools.jar once; needs java)
  npx tsx demo/server.ts --rehearsal --port 8799 --autostart   # then, once the run file appears:
  npx tsx scripts/check-run.ts latest               # expect: every line behaved
  ```

  The rehearsal demo needs no network. Kill only the server you started.

## W3: rework the Bridge and fix the review findings (next)

### Where it stands

Two designs were sketched in [`docs/design/bridge-rework/`](../design/bridge-rework/).

- **`design-a/`** is complete: `rationale.md`, `module-map.md`, a type sketch in `src/`, the revised TLA+ rules in `spec/Bridge.rules.tla`, and test stubs. Its shape is **gather, reduce, interpret**.
  - Slow work (Decider, the check, Bedrock, the judgment seam) runs with no lock held, against a snapshot.
  - A pure, total `Step.reduce(state, input)` is the only place the claim, request, job and floor machines meet.
  - The shell commits with one `Ref.modify`, then runs commands. A job can therefore only start after the transition that records it is committed.
  - Each job has a deadline owned by the Bridge. A failed or timed-out job starts a direct fallback (a re-check, for claims).
  - The caller reports when Egg Head finished speaking (`Bridge.spoke(id)`).
  - The Event gets a typed `speech` (kind, certainty, basis, toward, about) and a list of `moves` (Opened, Dispatched, Reported, Closed, ...).
  - `Laws.ts` mirrors each TLA+ property as a predicate, and a test explores the real reducer.
- **`design-b-partial/`** was stopped partway, so it has no rationale. It is the same family: a pure `Core.reduce` that returns `Then` for the slow step, with the slow part's result fed back as an input (`Heard`, `PartialRead`, `Written`). It also has a `Policy.ts` with "one ordered list of candidates, the first that is due wins", and a `SpecSync.test.ts` that keeps the TLA+ action names and the input tags in sync. Treat it as a source of grafts.

Neither sketch has been type-checked against Effect 4.

### Steps

1. **Settle the owner's open questions.** Put these to the owner, each with the recommended option first, and log the answers as `direction` rows.
   1. Barge-in only with an Investigator, since a tentative barge promises a check? *Recommended: yes. Without an agent, Egg Head never cuts in, as before agent mode.*
   2. "Park that" naming no resource parks the newest open claim, until W5 measures a Decider question for it? *Recommended: yes.*
   3. A tentative barge that the agent later overrules, or cannot verify: say a short retraction out loud, or only add a dashboard note? *Recommended: say it ("Correction: my quick check was wrong, orders-db looks fine.").* A wrong interruption left uncorrected is the worst outcome on a call.
   4. A Bedrock writer failure falls back to the template line instead of failing the step? *Recommended: yes.*
   5. The quiet needed between two Egg Head lines ("one line per gap"). *Recommended: 3 s, as a Tuning knob, measured in W7.*
2. **Merge the designs.** Use design A as the base, and graft from design B:
   - `Policy.ts`'s ordered list of candidates, in place of scattered branches;
   - feeding slow results back as inputs;
   - `SpecSync.test.ts`.

   Write the merged rationale (problem, usage, shape, the synthesis decision, tradeoffs, alternatives) to `docs/design/bridge-rework/README.md`. Include the table mapping each review finding to the part of the design that fixes it.
3. **Write a failing test for each finding first,** and commit the tests before the fixes. They must fail on the current code. Most of them are scenario files or lines in `data/calls/`, judged by `src/Judge.ts`:

   | Finding | Repro to commit first |
   |---|---|
   | 1. Barge-in on an unconfirmed or corrected claim | A scenario where a claim is corrected, then a partial names its resource with `act` high: expect no barge. A scenario where a barge happens while the second look runs: expect it tentative (needs the Event change). |
   | 2. "On it" never answered | "Egg Head, can you take a look at this?" naming no resource, `addr` 0.9: expect an ack and then a "couldn't find that out" answer. |
   | 3. A failed second look counts as confirmed | A scenario with `agent.fails: "timeout"` on a confirm: expect a recheck job and an unverified flag (basis `fastCheck`). |
   | 4. Jobs forked before commit | A unit test where the writer fails after a dispatch: no duplicate job, task ids unique. |
   | 5. A later true claim no longer repairs | "orders-db is fine", then "orders-db CPU is at 98" from someone else: expect no investigation and quiet. |
   | 6. Parking blocks every claim | Two wrong claims on different resources, then "let's park the DB": expect the DB claim closed and the other one still raised. |
   | 7. Back-to-back lines | Switch on `OneLinePerGap` in the existing scenarios (it fails today on the ack-then-answer and take-then-answer lines). |
   | 8. Ticker death, orphan turn | A unit test where `tick` fails once: later lines still get decisions. |
   | 9. No Bridge-owned deadline | An Investigator that never answers: expect the fallback after the deadline. |
   | 11. Commit interrupted between write and publish | A unit test that interrupts a barge mid-commit: either both or neither. |
   | W4 "unknown" | The agent reports `unknown` on a claim (expect quiet with a note) and on a question (expect "couldn't find that out"). |

4. **Implement the merged design.** Make the Event change and extend `src/Expect.ts` and `src/Judge.ts` with `certainty`, `basis`, a `recheck` job and a `Closes{resource}` outcome. Update `demo/web/store.js`, `dashboard.js`, `meeting.js` and `tree.js` for the new Event shape. Add `unknown` to `demo/agent/bin/egghead`, the `/agent/report` schema and `SYSTEM.md` ("say unknown when what you saw does not settle it; never guess a number").
5. **Parity.** Without an Investigator, behaviour must stay the same apart from the parking change. That change is deliberate, so move the Python oracle with it:
   - add the scoped parking to `cost_level` in `spike/egghead_gate.py`;
   - run `python3 spike/gate_eval.py`, which should still match `spike/REPORT-gate.md` or the change should be explained;
   - run `python3 spike/export_gate_parity.py`;
   - say in the commit message that the fixture moved, and why.

   The ten Bridge traces in `test/Parity.test.ts` should not move, unless one has a parking line with two open claims.
6. **Update the TLA+ model to the new code:**
   - follow design A's `spec/Bridge.rules.tla`;
   - replace `NeverSaysUnconfirmed` with `NeverFirmOnUnconfirmed`;
   - add `TentativeIsChecked`, `ParkingIsScoped` and `OneLinePerGap`;
   - keep each action cited to `file:line`.

   `spec/check.sh` must pass every rule. Then show each rule failing on a deliberately broken version of the model (for example, drop the corrected-claim guard from `Barge`) and restore it.
7. **Add the scenario for the owner's "unverified flag" wording,** and every scenario for the new `never` rules.
8. **Re-run the mutants.** Add knobs for the new Tuning values (gap quiet, job deadline) and make sure each is caught.
9. **Ask an independent reviewer** to try to break the finished diff, focusing on lifecycles that never end and on races. Fix what they rate act-on, and log the rest.

## W4: the agent says "couldn't tell"

The code is part of W3 (step 4). The blind test of the prompt change needs Bedrock and is in `blocked-work.md` §4.

## W5: measure the new Decider questions

This is experiment 12 in `blocked-work.md` §3. When its results arrive:
- put the chosen wording, format, Platt parameters and threshold for `addr`, `ask` and `act` into `src/Conversation.ts`;
- put the winning variant for corrects, parks and answered behind the judgment seam (`Judgments`);
- add a `Tuning` knob for each new threshold and a mutant for each;
- update the FINDINGS headline table and `AGENTS.md`.

## W6: live mic

Goal: real people on a real microphone can run the demo. Today only scripted call audio exists.

1. **Fix the known gap first.** Transcribe mode never feeds `Bridge.partial`, so barge-in cannot happen with real audio. `Voice.transcribe` drops `IsPartial` results. Feed partials, with the speaker, into `session().partial`.
2. **Design it twice.** Options to compare:
   - Audio path: browser `getUserMedia` to an AudioWorklet producing 16 kHz PCM, sent over a WebSocket to Transcribe streaming on the server; or Transcribe streaming straight from the browser with short-lived credentials.
   - Who is speaking: one mic per person tab (the tab knows who is unmuted), or Transcribe speaker labels on one mic.
   - Echo: Egg Head must not hear its own Polly voice. Use the browser's `echoCancellation: true`; also mute input while the Egg Head clip plays, and tell the Bridge with `spoke()`.
   - VAD silence ticks from the audio energy, in place of the scripted line ends.
3. **Test it on the real surface without people.** Run Chromium with `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>`, playing a recorded call (for example, the Polly clips of a scenario concatenated with pauses). Score the run with `check-run`. Playwright and Chromium are installed in the cloud container. Live runs need Transcribe (AWS).
4. **Docs:** add a "Live mic" section to `AGENTS.md` and `demo/RECORDING.md`.

## W7: latency, from end of line to Egg Head speaking

1. **Build `scripts/latency.ts`.** It plays a scenario and reports, for each Egg Head line: time from the line's end to the decision, to the writer done, to the voice ready and to playback start. Split it by stage: Decider batches, agent job, Bedrock writer, Polly.
2. **Vet the harness before trusting it:**
   - What limits each stage? Profile it.
   - Was each side tuned as production runs it?
   - Do the numbers break physical limits?
   - Does it count errors?
   - Do at least 5 runs per side, alternating, and report the median and range.
   - Does the stage matter end to end?
   - Did the work actually happen inside the timed region?
3. **Freeze the harness, then improve one change at a time.** Each attempt is one hypothesis and one change. Measure before and after, keep the change only if the number moves past the noise and `npm test` stays green, and log every attempt (kept or reverted) as a row. Candidates to try:
   - the gather outside the lock (W3 design);
   - running the gate batch alongside the Investigator;
   - Polly while Bedrock streams;
   - pre-synthesised acks;
   - a nearer voice region.
4. Live numbers come from the owner's machine (`blocked-work.md` §4).

## W8: finish

1. **Statechart.** Draw what people on the call see (listening, checking, holding the floor, speaking, barging in, answering) as Mermaid. Generate it from the W3 TLA+ model, with each rule as a note. Render PNGs for the README and the article.
2. **Comments.** Remove comments that narrate what the code does. Keep only the non-obvious *why*.
3. **Writing pass** on `README.md`, `AGENTS.md`, `research/decider/FINDINGS.md` and `demo/RECORDING.md`:
   - short declarative sentences;
   - every number with its source file;
   - claims labelled measured, inferred or guess;
   - remove the README to-do items that are done, and update test counts and commands.
4. **Turn text rules into checks.** Each check must fail on a real past mistake:
   - changing gate wording or thresholds without regenerating the parity fixture (a test that hashes the gate's wording and constants against the fixture header);
   - every Decider HTTP request sends `model` and a named User-Agent (a test over `src/Decider.ts`);
   - no Decider batch has more than 8 questions (a test over every question set);
   - the Bridge never compares against a module constant directly, only through `Tuning` (a lint-style test that greps `src/Bridge.ts`).

   Add a table to `AGENTS.md` pairing each rule with what enforces it.
5. **Mark the PR ready.** Check that `npm run check`, `npm test`, `spec/check.sh` and a rehearsal `check-run` are all green, and update the PR description.

## Owner-side items

- **Network.** The cloud environment blocks `api.decider.cloud`, `openrouter.ai` and `huggingface.co`. Either run `blocked-work.md` on a machine that can reach them, or allow them in the environment's Network access settings.
- **Merging.** The first commit on the branch, `0ad940f`, has a message the owner wants gone. Squash-merge the PR, or reword it with an interactive rebase and a force-push.
