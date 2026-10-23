# Behaviour harness: design

Egg Head's product is a decision: when a voice agent on a multi-party call should stay quiet, investigate, speak, reply, take a question or barge in. This harness writes those decisions down as typed expectations. Each scenario plays through the real call loop in virtual time, and the same judge scores a saved live run. The incident demo is one scenario among several.

The design came from two independent candidate designs (Opus, Sonnet) and a cross-judge. Both candidates reached the same core shape independently. That shape is one call loop shared by the demo, the tests and live scoring; typed per-line expectations; and one pure judge over the call log. Candidate 2 was the base, and the strongest parts of candidate 1 were grafted on.

## Usage

```ts
// test/scenarios/*.test.ts: a focused scenario in a few lines
const call = scenario("hanging question", [
  line("Lee", "Did anyone push anything to the payments API today?", {
    pause: 3.0, decider: { ask: 0.9 },
    expect: [investigates("answer"), says("ack", { toward: "Lee", when: afterEnd(2.5, 3.0) }), says("answer", { toward: "Lee" })]
  })
])
it.effect("takes a question nobody answers", () => behaves(call))
```

```bash
npx tsx scripts/check-run.ts latest     # score the last live run: "17 of 18 lines behaved as expected"; exit 1 on a miss
```

Every file in `data/calls/` is a scenario. `test/Scenarios.test.ts` plays each one, so there is no second list to keep in sync.

## Shape

- **`src/Call.ts`** holds the text-mode call loop moved out of `demo/Run.ts`: ticks, partials from word marks, the humans' hold while Egg Head talks, and `waitForEggHead`. It runs on `Clock` only, through a `session()` that the Transcribe driver in `demo/` reuses. `Message` becomes a Schema whose `event` is the Bridge `Event`. The loop stamps `at` from `Clock`, so a TestClock run and a live run produce the same log. Page-only messages (`stats`, `status`) stay in `demo/`.
- **`src/Sound.ts`** is the voice seen as durations and word marks: Polly in the demo, estimated marks offline.
- **`src/Hints.ts`** is the hinted Decider (from `test/helpers.ts` and `demo/Rehearsal.ts`), now with a Schema, so a typo in a hint fails at decode. Its latency is deterministic. `test/helpers.ts` re-exports it, so the parity tests are untouched, and `demo/` no longer imports `test/`.
- **`src/Expect.ts`** holds the vocabulary.
  - Per line, `expect` is a closed list of outcomes: `Says{ kind, toward?, about?, when?, certainty?, basis? }` and `Investigates{ job }`. `[]` (the default) means quiet: no speech, no investigation, no cut. Anything not listed fails.
  - Per call, `never` lists invariants: `NoTalkOver`, `SilenceBeforeSpeaking`, `OneLinePerGap`, `Cooldown{ unprompted }` and `NeverOnCorrected`.
  - Parking is checked as a `Closes{ resource }` outcome.
  - Every field is read from Bridge `Event` fields, never from the spoken words. That way a reworded Bedrock line does not fail a live run.
- **`src/Judge.ts`** is pure. `observe(log)` gives the observed outcomes per line, and `judge(call, log)` gives a `Report` of typed problems (`Missing` with a `foundIn` line, `Unexpected`, `Mismatch`, `NotPlayed`). Its `Tolerance` setting applies one of two policies.
  - `offline` is tight.
  - `live` forgives up to 1 s of lateness for Decider and ASR latency, and never forgives being early.
- **Scenario data** carries an optional `world` patch and an optional `agent` setting: `false` for no Investigator, or delays, what the agent sees, and whether it fails or times out. Overrule, delay and failure paths are therefore data, and the same file can be played live.
- **`src/Tuning.ts`** puts every threshold and timing the Bridge compares against in one `Context.Reference`. Its defaults are built from the existing constants. `Gate.decide` takes a defaulted `GateTuning`, so the parity fixtures are unchanged. `test/Mutants.test.ts` breaks one setting at a time and requires a scenario to fail, naming the first failing line. A surviving mutant means either that the Bridge bypasses `Tuning` or that no scenario covers that behaviour.
- **Run files** embed the scenario they ran (`{ scenario, run, log }`), so a later edit to the script cannot change the score. Old files still load through their `call` path.

## Rejected

- **A second, lean driver over `hear`, `tick` and `partial`.** It would re-implement the timing under test.
- **`vi.doMock` for mutants.** It misses in-module references and duplicates Effect service identities.
- **A free-text or LLM judge.** It is not deterministic and cannot gate CI.
- **Matching on spoken wording.**

## Accepted costs

- `demo/Run.ts` is refactored into `src/Call.ts`.
- Expectations repeat their numbers (2.5 s) instead of importing the constants, because the expectation is the spec.
- Unlisted behaviour fails, so a new kind of line turns the scenarios red until they are updated.
