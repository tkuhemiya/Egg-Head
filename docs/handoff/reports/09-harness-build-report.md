# Behaviour harness: build report (deviations, mutants, bugs it found)

_A delegated report from 23 Oct 2026, kept as written. Line numbers are at the commit it names or at 7dd7885 (before this PR). Treat claims as findings, checked where docs/handoff/continue.md says so._

## W1 behaviour harness: report

The behaviour harness is built as `docs/design/behaviour-harness.md` describes. Every file in `data/calls/` now plays offline through the real call loop under TestClock. One pure judge scores those offline runs and saved live runs alike. Nothing is committed; all changes are in the working tree. `demo/Rehearsal.ts` is deleted but not staged.

**Status:**
- `npm run check` is clean.
- `npm test` passes 101 of 101: the 65 existing tests plus 36 new ones.
- `git diff --stat -- test/Parity.test.ts test/fixtures` is empty.
- Every one of the 10 mutants is caught by at least one scenario.
- The real demo in rehearsal mode scores 18 of 18 lines with the pi agent and 14 of 18 with `--agent none`. The 4 misses are the lines that need an agent, as expected.

### Files

**New in `src/`:**
- `Call.ts` holds the scenario schema (typed `expect`, `why`, `world`, `agent`, `never`, `Hints` in `decider`), the `Logged` log schema whose `event` field is the Bridge `Event`, `decodeLog`, `Floor`, `session()` and the text-mode `play()`.
- `Sound.ts`, `Hints.ts`, `Expect.ts`, `Judge.ts` and `Tuning.ts` as in the design.

**Changed in `src/`:**
- `Gate.ts`: `GateTuning`, `GATE_DEFAULTS`, and defaulted tuning arguments on `decide` and `repairedBy`.
- `Conversation.ts`: `ReplyTuning`, and a defaulted tuning argument on `readyToReply`.
- `Bridge.ts`: reads every threshold and timing through `Tuning`.

**New outside `src/`:**
- `test/harness/Offline.ts` has `record`, `score` and `behaves`. It steps the clock 50 ms at a time with a 600 s virtual cap; a run still going at the cap fails as a hang.
- `test/Scenarios.test.ts`, `test/Judge.test.ts`, `test/Mutants.test.ts`.
- `scripts/check-run.ts`.
- Seven focused scenarios in `data/calls/`: `hanging-question`, `spoken-to-mid-sentence`, `barge-in`, `agent-overrules`, `agent-fails`, `flag-at-the-gap` (no agent, plus the cooldown), and `unfinished-turn` (no agent, the 1.2 s silence rule). All of them can be played with `--call`.

**Changed outside `src/`:**
- `demo/Run.ts` keeps only `DeciderMeter`, the page stats and the Transcribe driver, which now runs on `session()`.
- `demo/Voice.ts` gives the Voice to the loop as `Sound`, and marks moved to `src/Sound.ts`.
- `demo/server.ts`:
  - Decodes calls strictly.
  - Uses `hinted()` for rehearsals, with a fixed 200 ms latency.
  - Writes `{scenario, run, log}` run files.
  - Prints the score after each run.
- `test/helpers.ts` is now a re-export of `src/Hints.ts`.
- `data/calls/checkout-incident.json` has typed expectations; the old prose moved to `why`.
- `demo/Rehearsal.ts` is deleted.

### Where I differed from the design, and why

1. **`claim` on every flag.** Without an Investigator, the Bridge now sets `claim: item.turn` on gate decisions too; before, only agent mode did. Without it, the judge cannot tell whom a no-agent flag is for or what it is about. Parity does not compare this field, so the fixtures did not move. The dashboard's `store.js` already prefers `ev.claim` when present.
2. **Scenario decoding is strict.** It uses `onExcessProperty: "error"`, because Effect ignores unknown keys by default. Without this, `{"clam": 0.9}` would decode silently, which defeats "a typo in a hint fails at decode." I renamed `_note` to `about` for the same reason.
3. **Rehearsal Decider latency is a fixed 200 ms**, not random 120 to 300 ms. Rehearsal runs are now repeatable.
4. **Agent failure is one field.** `agent.fails` is `"error" | "timeout"` rather than two booleans, so "both failed and timed out" cannot be written. A timeout waits 60 s, the demo's `--agent-timeout` default, then fails.
5. **`take` is a kind of its own.** The judge reports an `ack` as a `take` when the Bridge event's request is an open question to the call.
6. **`Cooldown` is measured between decision times.** A flag must come at least `s` seconds after the previous unprompted line, a flag or a barge. Barges are not held by it, which matches today's gate.
7. **Run times line up with the page.** The loop stamps `at` from Clock, counted from an `originMs` the server passes in, so live run files stay aligned with `scripts/record-demo.ts`. The page still gets `expect` as a rendered string, `describe(expect) · why`. `audio` is still a URL in the demo and `""` offline.
8. **The offline harness lives in `test/harness/`**, and `check-run` has no `--simulate` option.

### Mutants: the first failing line for each

| Mutant | First failing line |
|---|---|
| `OPEN_SILENCE_S` 1.0 | `agent-fails.json` line 0 (Lee, "Did anyone push…"): take to Lee about payments-api, 2.5 to 3 s after the line; `when` differs |
| `T_DIRECTIVE` 1.01 | `barge-in.json` line 2 (Priya, "Okay. Jordan, restart the payments API now…"): missing barge to Priya about payments-api |
| `REPLY_MAX_WAIT_S` 1.0 | `checkout-incident.json` line 9 (Priya, "Egg Head, can you check the, uh…"): unexpected investigates (answer) |
| `T_MIN_SILENCE_S` 0 | `checkout-incident.json` line 4 (Priya, "Okay, so let's focus on the API then."): flag to Sam about orders-db, not before 0.5 s; `when` differs |
| `T_SILENCE_S` 0.5 | `unfinished-turn.json` line 1 (Mei): flag to Sam about orders-db, 1.2 to 1.5 s after the line; `when` differs |
| `T_FLOOR` 1.01 | `flag-at-the-gap.json` line 1 (Priya): flag to Sam about orders-db, 0.5 to 1 s; `when` differs |
| `T_ADDRESSED` 1.01 | `checkout-incident.json` line 10 (Priya, "the checkout queue?…"): missing investigates (answer) |
| `T_ASKS` 1.01 | `agent-fails.json` line 0 (Lee): missing investigates (answer) |
| finished 1.01 | `checkout-incident` line 10 and `spoken-to-mid-sentence` line 1 fail (from a scratch run of every mutant against every scenario). The first one the test prints was not captured. |
| cooldown 0 | `flag-at-the-gap` lines 3 and 4 and its `Cooldown` invariant fail (same scratch run). The first one the test prints was not captured. |

No mutant survived. I also tried `selfRepaired` 0 and `costLevel` 99, which are not on the list. Both are caught by several scenarios.

`T_SILENCE_S` is the most thinly covered knob: only `unfinished-turn.json` catches it.

### Bugs the harness found, deferred to W3

These are left out of this unit's expectations, as the brief asked.

1. **Review finding #7: back-to-back lines.** I left `OneLinePerGap` out of the checkout scenario and the focused ones. Today's code fails it at `quietS: 2`. Log excerpt from the checkout call, line 13 (seconds since the call started):
   ```
   78.88 event 13 ack (take) "I can check that."  agent dispatched
   78.88 egghead 13 "I can check that." 1.77 s
   81.88 event 13 (agent) reported
   81.88 event 13 answer "Lee, payments-api: last deploy 9 days ago."
   ```
   The answer starts 1.23 s after the take ends, and nobody speaks in between. The spoken-to and hanging-question scenarios have the same ack-then-answer shape, so I left `OneLinePerGap` out of them as well.
2. **Review finding #2: "On it" is never answered.** A scratch scenario at default tuning, not committed: "Egg Head, can you take a look at this?" with `addr` 0.9 and no resource named.
   ```
   4.30 egghead 0 "On it, Priya."
   ERROR SupportError: no resource named in the question
   4.69 hold 0 on ... 14.79 hold 0 off (the full 10 s waitForEggHead)
   16.66 hold 1 on ... 36.66 hold 1 off (the full 20 s end-of-call wait)
   ```
   The judge reports "missing answer to Priya". The `REPLY_MAX_WAIT_S` mutant runs into the same bug, which is the `SupportError` log you will see in the mutant test output.
3. **Review finding #1: barge-in on a claim nobody confirmed.** In the checkout call, line 15 barges on Jordan's line-14 claim, which was never even sent for a second look. I kept `barge` as the expected outcome, because the owner wants a tentative barge there. Whether the barge is firm or tentative cannot be checked until W3 adds that field to the Bridge Event. The focused `barge-in.json` barges on a confirmed claim: confirmed at 10.13 s, barge at 12.75 s.

### Existing demo expectations that were wrong for today's code

These were not bugs in the code. The old prose labels said "flag" on lines 2, 6 and 14, but the correct behaviour on all three is quiet:
- Line 2 waits one turn for the call to correct the claim.
- Line 6 is corrected by line 7.
- Line 14 has no gap to raise it before the next line.

I rewrote those three `why` strings and kept every other one as it was.

### Coverage gaps, and things left out of this unit

- None of the scenarios covers the agent's confirm job failing or timing out. Writing one would encode review finding #3 (a failed second look counts as a confirmation) as expected behaviour.
- `certainty`, `basis`, `recheck` and `Closes` are not implemented. They would slot in as optional `Says` fields and a new `Outcome` variant once W3 adds the Bridge Event fields they read.

### Commands and results

- `npm run check`: clean.
- `npm test`: 11 files, 101 tests, all passed.
- `npx vitest run test/Mutants.test.ts --silent=false`: 10 of 10 mutants caught.
- `npx tsx --env-file-if-exists=.env demo/server.ts --rehearsal --agent none --port 8799 --autostart`, then `npx tsx scripts/check-run.ts latest`: 14 of 18 lines, 4 of 4 invariants, exit 1. The failures are lines 3, 10, 12 and 13, each missing its investigation, ack, take or answer. The script prints a note that the run had no Investigator but the scenario expects one.
- The same server command without `--agent none` (pi with the scripted rehearsal model, in a real pty) ran offline. `check-run latest` gave 18 of 18 lines and 4 of 4 invariants, exit 0. The full table is the same as the offline result, every line "ok".
- An old-format copy of that run (`{mode, writer, agent, rehearsal, call, history}`) also scores 18 of 18, exit 0.
- `check-run` on a missing file, or with no runs saved yet, exits 2.
- Nothing in either rehearsal run reached the network. I stopped both servers I started, and no `server.ts` process is left running.

The scratch tools I used to probe today's behaviour, find every scenario that kills each mutant, and reformat the call JSON are in `(scratch tools, not kept)/`.

### Principles applied

- **Model the domain.** `expect` is a closed list of tagged outcomes, `agent.fails` is a single literal union rather than two booleans, and `take` comes from the request kind.
- **Boundary discipline.** Scenarios, hints and run logs are decoded strictly at the edges; the judge is a pure function over typed data.
- **Test behaviour, not implementation.** The judge tests include cases that must fail, the mutants prove each knob is pinned, and the determinism test plays the same scenario twice and compares the logs.
- **Prove it works.** I scored real demo runs, not only offline ones.
