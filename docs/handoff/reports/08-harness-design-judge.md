# Behaviour harness: cross-judge of the two designs

_A delegated report from 23 Oct 2026, kept as written. Line numbers are at the commit it names or at 7dd7885 (before this PR). Treat claims as findings, checked where docs/handoff/continue.md says so._

## Cross-judge verdict: candidate 1 vs candidate 2

Paths below are relative to `(harness design sketches, not kept)/`. I read every file in both candidates. Every function body in both is a stub, so I scored the designs, not running code. In the repo, `src/Gate.ts` already has `COOLDOWN_S = 30` and a `PARKED` regex. Nothing in `src/` mentions tentative wording, an unverified flag or a re-run of the fast check, so those new rules need new Bridge `Event` fields whichever candidate is the base.

### Scores

| # | Criterion | C1 | Evidence C1 | C2 | Evidence C2 |
|---|---|---|---|---|---|
| 1 | One shared loop | 4 | `candidate-1/src/Call.ts` `play`/`playCollect` is used by the demo, `Scenario.simulate` and `check-run --simulate`. But rationale.md "Tradeoffs" accepts that Transcribe mode stays a second, unsimulated loop in `demo/Run.ts`. | 5 | `candidate-2/src/Call.ts` has `playCall` plus the `CallSession` / `session()` pieces, so the Transcribe driver reuses the same floor, ticks, holds and publishing. The offline driver (`test/harness/Offline.ts`) only builds layers and advances the clock. |
| 2 | Expectation vocabulary | 2 | `candidate-1/src/Expect.ts` `ActKind` and `Say`: an exact ordered list per window plus `mentions` (a substring) and `investigates: boolean`. There are no call-wide rules, no firm vs tentative barge, no unverified flag or re-check, and timing applies to the first act only. Tentative wording could only be checked with a `mentions` substring. | 3 | `candidate-2/src/Expect.ts` has `Says{kind,toward,about,when}`, `Investigates{job}` and call-wide `Invariant` (`NoTalkOver`, `SilenceBeforeSpeaking`, `MaxSpeeches`). It has the right shape for one-line-per-gap and the cooldown as invariants, but still has no certainty (firm/tentative), no unverified basis, no `recheck` job, and nothing for the parking scope. |
| 3 | Breakage visible | 4 | `candidate-1/src/Tuning.ts`: `Context.Reference` with defaults built from the constants, plus `GateTuning` as a defaulted argument so parity is untouched. A Bridge comparison that bypasses Tuning lets its mutant survive, so the rule enforces itself. There are 10 mutants over all scenarios. Weakness: "a miss anywhere" is a loose kill criterion (`test/Mutants.test.ts`). | 2 | `candidate-2/test/Mutants.test.ts`: `vi.doMock` + `vi.resetModules`. Patching `T_DIRECTIVE` or `readyToReply` in `Conversation.ts` does not change that module's own internal references, and it depends on how `Bridge` imports (the rationale's open questions admit this). Re-imported modules also risk duplicate Effect service identities. Only 3 mutants, on the demo call only. Its `firstFailing` line assertion is sharper than C1's. |
| 4 | Interface depth and dependency direction | 3 | `candidate-1/module-map.md` "New": the `src/Scenario.ts` public surface is about 17 exports (`hintedDecider`, `answersFor`, `layer`, `noul`, ...), and `src/` imports `effect/testing` (rationale "Tradeoffs"). `demo/Rehearsal.ts` is deleted, so demo no longer imports test. | 4 | `candidate-2/MODULES.md`: the public surface is `behaves` plus `judge`. `Judge.ts` is pure, `effect/testing` stays in `test/harness`, and the direction is `test, demo, scripts -> src`. Minus: the `Message` schema in `src/Call.ts` carries page-only `stats`/`status`, and `CallLine.expect` is a required field. |
| 5 | Determinism and agent paths | 4 | `candidate-1/src/Scenario.ts` `Scenario.agent` (`false` / `confirmS` / `answerS` / `sees`) is scenario data, with `data/calls/agent-overrules.json`. Decider latency is fixed. `test/Scenarios.test.ts` has a "same log twice" determinism test. The 50 ms stepping risk with forked background jobs is flagged as an open question. No agent-failure path. | 3 | `candidate-2/test/harness/Offline.ts` `agent: "direct" \| "none" \| Layer` can express slow or failing agents, but only from TypeScript, not scenario data. No determinism test, no overrule scenario, and `test/Judge.test.ts` is all `todo`. |
| 6 | Live scoring robustness | 3 | `candidate-1/src/Expect.ts` header: attribution by the loop's `index`, act kinds read from `event` entries (so a dropped Polly line doesn't matter), `foundIn` reports "came in line 14", and `CallRecord` embeds the scenario. But there is no latency tolerance (open question), and `mentions` depends on wording. | 4 | `candidate-2/src/Judge.ts`: `Tolerance.live` forgives lateness only (`lateS: 1.0`, `earlyS: 0.05`), `toward`/`about` come from the event, not the words, matching is a bag per line, invariants are checked, there is a `--partial` option and `ScriptMismatch`. Minus: a `Recording` stores only the `call` path, so the script can be edited after the run. |

Totals: C1 = 20, C2 = 21.

### Recommendation: base on candidate 2

The vocabulary is the hardest part to retrofit and the part the new rules depend on. C2's typed `Outcome` union, call-wide `Invariant`s, event-derived `toward`/`about` and asymmetric `Tolerance` can be extended to cover the new rules. C1's per-window `say` list cannot express call-wide rules at all. C1's strongest piece, `Tuning`, is self-contained and moves over cleanly.

### Grafts from candidate 1
1. **`Tuning` / `GateTuning` / `TuningPatch` / `patch`** (`src/Tuning.ts`, plus defaulted arguments on `Gate.decide`, `repairedBy` and `readyToReply`) replace `vi.doMock` completely. Keep C2's `firstFailing` assertion, and also run every mutant over all `data/calls/*.json`. Port C1's 10-mutant list and add mutants for the new rules: `cooldownS: 0`, a one-line-per-gap knob, and tentative/firm.
2. **Scenario-level `agent` config** (`false` / `confirmS` / `answerS` / `sees`) as data on `Call`, so overrule and delay paths live in JSON and can also be played live. Extend it with `fails` / `timesOut` for the failed-second-look rule.
3. **Determinism test** ("the demo call gives the same log twice", `test/Scenarios.test.ts`) and the **virtual-time cap reported as a failure** (`SimulateOptions.maxS`).
4. **Focused scenario files**: `barge-in.json` (a mention is not an instruction), `spoken-to-mid-sentence.json`, `hanging-question.json`, `agent-overrules.json`.
5. **`CallRecord` embedding the scenario** (`{scenario, run, log}`) with a `--scenario` override and old-format fallback, instead of C2's bare `call` path.
6. **`foundIn` diagnostic** on a missing act ("answer came in line 14"), added to C2's `Missing` problem.
7. **Decode-time filters on `Expect`** (no timing bound on a quiet line; `notBeforeS <= withinS`), and C1's concrete judge tests on hand-written logs (`test/Expect.test.ts`) to replace C2's `it.todo`s.
8. **`forPage` wrapper** (`demo/Run.ts`): keeps page-only `stats`/`status` out of the `src` log schema.
9. Optional **`check-run --simulate`**. Put the offline driver in a shared non-`src` module (for example `harness/`) that both `test/` and `scripts/` import, so `src/` never imports `effect/testing`.

### New vocabulary neither candidate has (add to C2's `Expect.ts`, derived from new `Event` fields, never from wording)
- `Says.certainty: "firm" | "tentative"`, so barge and flag can be checked as firm only after the agent confirmed, and tentative while the second look runs.
- `Says.basis: "confirmed" | "fastCheck" | "unconfirmed"`, for the failed-second-look flag.
- `Investigates.job: "confirm" | "answer" | "recheck"`.
- Invariants:
  - `OneLinePerGap{ quietS }`: any Egg Head line counts as speaking; its next line needs a human turn or `quietS` of silence.
  - `Cooldown{ s: 30, appliesTo: "unprompted" }`: asked-for answers are exempt.
  - `NeverOnCorrected`: no flag or barge on a claim the call already corrected.
- Parking: an observed `Closed{ resource }` outcome, or an invariant saying parking resource X never silences a claim about Y.

### Reject
- C2: `vi.doMock` mutation (unreliable for in-module references and Effect service identity).
- C2: `Recording.call` as a bare path (the script can drift after the run).
- C2: page-only `stats`/`status` members in the `src/Call.ts` `Message` schema.
- C2: `expect` as a required field on `CallLine`; make it optional, defaulting to `[]`.
- C1: `effect/testing` imported from `src/Scenario.ts`.
- C1: `mentions` substring as the main content check (it fails when the writer rewords; keep at most a debug note).
- C1: one exact ordered `say` list per window as the only shape. It cannot express call-wide rules, and timing covers the first act only.
- C1: accepting Transcribe as a second loop; adopt C2's `session()` split instead.
- C1: the very wide `Scenario.ts` export surface. Keep the hinted Decider in C2's `src/Hints.ts`.

