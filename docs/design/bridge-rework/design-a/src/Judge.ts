/**
 * DELTA to src/Judge.ts / src/Expect.ts: what the Judge reads from the new Event, never the words.
 *   Said        { kind: speech.kind, certainty: speech.certainty, basis: speech.basis, toward, about }
 *   Dispatched  from moves Dispatched{kind: confirm | recheck | answer}      (Investigates.job gains "recheck")
 *   Closes      from moves Closed{why:"parked", resource}                    (Outcome Closes{resource})
 *   Reported    from moves Reported{end: found|unknown|failed|timedOut}      (Reports{job, end}, optional)
 * Expect.Says gains optional `certainty` and `basis`; SaidKind gains "retract" (not in UNPROMPTED: no cooldown).
 * New call invariants, all derived from `speech`:
 *   NeverFirmOnUnconfirmed   a firm speech with basis fastCheck is a violation when the call has an Investigator
 *   NeverOnCorrected         unchanged, now reads Closed{corrected|parked} moves of the same claim
 *   OneLinePerGap            unchanged vocabulary; now true by construction, still judged on the live log
 * toward/about no longer need a claims map rebuilt from route: Speech carries them.
 */
export type { Speech, Move } from "./Event.ts"
