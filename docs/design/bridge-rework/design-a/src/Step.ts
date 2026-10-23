/**
 * Step: the reducer. Pure, total, deterministic. The only place the machines meet.
 *
 * reduce(s, input, ctx):
 *   0 sweep    expired jobs -> the same path as JobDone(TimedOut); Floor.expire
 *   1 handle   one handler per Input tag (below); each returns the next State, moves, commands
 *   2 commit   append the Event to state.events with the next seq (atomic with the state; Bridge publishes it)
 *
 * Every handler is a short sequence of slice calls; mode differences live in `ctx.policy`.
 */
import { Option } from "effect"
import * as Agenda from "./Agenda.ts"
import * as Claims from "./Claims.ts"
import * as Floor from "./Floor.ts"
import * as Jobs from "./Jobs.ts"
import * as Requests from "./Requests.ts"
import type { Ctx, Input, State, Transition } from "./State.ts"

export const reduce = (_s: State, _i: Input, _ctx: Ctx): Transition => { throw new Error("not implemented") }

/*
 LineBegan       turns += line; analysing += 1. No event. (hear's first transact; returns the turn index)

 LineUnderstood  (the old 130-line hear, now seven calls)
   s1 = Claims.judge(s, ev.verdicts)               corrects/parks closed per claim, jobs Cancelled
   s2 = Requests.intake(s1, line, ev.verdicts)     (no-op unless policy.conversation)
   s3 = Claims.secondLook(s2)                      Fresh && turn < this turn -> Checking + StartJob (before observe: the new claim is not looked at yet)
   s4 = Claims.observe(s3, ev.check)               contradicted -> new claim; supports already used in verdicts
   s5 = line signals (finishedP, interruptP, escalations) stored
   s6 = analysing -= 1
   pick = Agenda.next(s6, Floor.silence(...))      Held when !Floor.mayStart
   s7 = apply pick via the owners: Claims.spoken / Requests.worked|answered / Floor.take
        -> Speech built here (kind, certainty from Voice, basis, toward, about); Compose command only if a Writer must write the flag
   event = line fields + speech + moves

 LineFailed      analysing -= 1; Event{moves:[Note "could not understand this line: reason"]}; Bridge re-raises to the caller after committing

 Silence         if analysing>0: Held{analysing}, never speaks. else same tail as LineUnderstood (Agenda -> apply). Event only if moves/speech non-empty.

 PartialHeard    guards on the CURRENT state, not the snapshot:
                   policy.barge && analysing==0 && claim exists && Claims.bargeable(claim)
                   && corrects verdict for the claim over (lines + partial) < threshold   (never on a claim the call already corrected)
                   && Floor.mayStart && actP >= tuning.directive
                 then voice = Claims.bargeVoice(claim)  (firm iff Standing{confirmed}; else doubleChecking, and Claims.spoken starts the confirm job in this transition)
                 else Note why not (Decider said not an instruction / guarded). Bookkeeping for `partials` happens in Bridge.reservePartial.

 JobDone         Jobs.finish (None -> no-op). Then by subject: Claims.jobFinished | Requests.jobFinished.
                 Failed/TimedOut on a primary job -> StartJob via:"direct" (recheck for claims; answer for requests).
                 Reported Unknown -> claim Closed{Undetermined} + Note; request Ready{Unable "unknown"}.
                 Then the Speech tail (a ready answer may now be sayable).

 Composed        Floor Composing{id}? else no-op. Re-validate (claim still Standing and not corrected) -> Speaking + publish held draft with speech;
                 else Floor Open + Held. None text -> code line.

 SpeechEnded     Floor.ended (idempotent). Event only for the dashboard Note.

 Sweep           step 0 only.
*/
export const pending = (_s: State): number => { throw new Error("not implemented") } // running jobs + Standing claims + owed retractions + live requests
