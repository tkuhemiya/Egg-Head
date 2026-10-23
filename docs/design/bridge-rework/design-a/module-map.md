# Module map (design A: gather / reduce / interpret)

Dependency order, leaf first. "owns" = the only module that writes it.

| Module | Role | Owns | Pure? |
|---|---|---|---|
| `src/Ids.ts` (new) | branded ids, Basis, Certainty, Voice | - | yes |
| `src/Event.ts` (new, out of Bridge.ts) | Event, Speech, Move | wire shape | yes |
| `src/Jobs.ts` (new) | job table, Report (Checked/Answered/Unknown), Outcome, deadlines | `state.jobs` | yes |
| `src/Claims.ts` (new, replaces `Ledger.ts`) | claim machine: Fresh, Checking, Standing, Closed | `state.claims` | yes |
| `src/Requests.ts` (new, from `Conversation.ts`) | request machine: Listening, Working, Ready, Closed | `state.requests` | yes |
| `src/Floor.ts` (new) | Egg Head's own speech as an input; one line per gap | `state.floor` | yes |
| `src/Judgments.ts` (new) | the seam: corrects / parks / answers; `today` rule; `Reference` | - | rule yes, seam Effect |
| `src/Gate.ts` (delta) | verdict-driven gate; regexes leave for Judgments | - | yes |
| `src/Agenda.ts` (new) | priority of what to say next (reads all machines) | - | yes |
| `src/State.ts` (new) | State, Input, Evidence, Command, Policy, Ctx | - | yes |
| `src/Step.ts` (new) | `reduce`: the one place machines meet | everything, via owners | yes |
| `src/Laws.ts` (new) | the TLA rules as predicates | - | yes |
| `src/Gather.ts` (new) | unlocked slow work -> Evidence | - | Effect |
| `src/Bridge.ts` (rewritten, ~150 lines) | shell: Ref, hear lane, `transact`, interpreter, public API | the Ref | Effect |
| `src/Investigator.ts`, `Speaker.ts`, `Conversation.ts`, `Tuning.ts`, `Call.ts`, `Judge.ts`, `Expect.ts` | deltas | | |
| `src/Ledger.ts` | deleted | | |

Call chain for any input: `Bridge.x` -> `transact` -> `Step.reduce` -> (`Claims|Requests|Jobs|Floor|Agenda`). Three files.
Public surface of `Bridge`: today's plus one method, `spoke`.
