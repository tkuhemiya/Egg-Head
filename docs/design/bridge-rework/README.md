# Bridge rework (W3)

## Problem

`Bridge.hear` holds one lock while it calls Decider, runs checks, writes lines, and forks Investigator jobs. Eleven review findings and five failing TLA+ rules come from four causes: lifecycles live as booleans, effects run before the state that records them is committed, Egg Head’s own speech is invisible to the Bridge, and slow calls share that lock.

Constraints: `Gate.decide` thresholds and `GateDecision` shape stay; Decider batches stay (ScriptedDecider and the ten Bridge traces); the harness reads typed Event fields; three language judgments sit behind a seam until W5; the owner’s decisions (including the five settled when this design was merged) hold.

## Usage

Callers keep `hear`, `tick`, `partial`, `run`, `state`, `pending`, `changes`. One new call: `Bridge.spoke(id)` when Egg Head’s line has finished (or was dropped). The judge reads `speech` (kind, certainty, basis, toward, about) and `moves`; `said` / `saidKind` / `agent` / `request` / `claim` / `note` stay filled as a compatibility projection so saved runs and the dashboard keep working.

## Shape

Gather (slow, no lock, against a snapshot) → `Step.reduce` (pure, total) → interpret commands after one `Ref.modify`. Jobs start only from a committed transition. Publish is uninterruptible with the write.

Owner decisions as data:

1. Barge only with an Investigator. Unconfirmed barges are tentative and start a confirm job. Never on a corrected claim. Firm only for `Standing{confirmed}`.
2. A failed second look starts a direct recheck. Still wrong → tentative flag (`couldNotConfirm`). Right → close overruled; if a tentative barge already went out, retract out loud.
3. One line per gap (`Floor.mayStart`): a human turn since, or `quietAfterSpeechS` (3 s) after Egg Head’s line ended. Cooldown stays on unprompted flags only. Barge skips the quiet-time half so it can cut a human, but it still requires the floor to be Open: Egg Head does not talk over itself.
4. Parking closes only open wrong claims about the named resource. “Park that” with no resource named parks the newest open claim.
5. Writer failure uses the template line instead of failing the step.

Grafts from design B: `Agenda` is one ordered list of candidates (answer, ack, take, retract, flag); slow results come back as inputs (`JobDone`, `Composed`, `SpeechEnded`); `test/SpecSync.test.ts` keeps TLA+ names aligned with code tags.

## What each finding becomes

| # | Finding | Where |
|---|---|---|
| 1 | barge on unconfirmed / corrected / right | `Claims.bargeable`; tentative + job; off without Investigator |
| 2 | “On it” never answered | job layer total; no-resource → Unknown; `Ready{Unable}` spoken |
| 3 | failed look = confirmation | Failed → recheck → `Standing{fastCheck, couldNotConfirm}` |
| 4 | job before commit | commands only from a committed Transition |
| 5 | later true claim no longer repairs | per-claim `Corrects` via check+resource |
| 6 | parked claim blocks | per-claim Parks closes it; every Standing claim is gated |
| 7 | own speech / back-to-back | Floor + `spoke` + one line per gap |
| 8 | ticker death / failed hear | ticker catch; `LineFailed` still commits an event |
| 9 | job deadline | `deadlineAt` from dispatch, Sweep |
| 10 | demo security | already landed; JobIds are epoch-scoped |
| 11 | commit not atomic | `Ref.modify` + uninterruptible publish |
| W4 | unknown | Report.Unknown; quiet on claims, spoken on questions |

## Tradeoffs

Larger module count for machines that TLC can check. `hear` stays serialized (moving the gather out of it is latency work, not done). Event gains `speech`/`moves` but keeps the old fields as a projection. Barge-in is off without an Investigator (finding 1). A caller who never calls `spoke` degrades to `maxSpeechS`.

## Alternatives not taken

Keep imperative `hear` with extra mutexes (invariants stay conventions). Actor-per-claim (cross-claim rules still need a coordinator). Full Elm with every await an Input (W7). Give Decider the whole state (research rejects it).
