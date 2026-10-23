------------------------------- MODULE Bridge -------------------------------
(***************************************************************************)
(* When does Egg Head speak? A model of the W3 reducer (src/Step.ts) in   *)
(* agent mode. Each input tag is one action; citations are to the code.    *)
(*                                                                         *)
(* ClaimStatuses  <-> src/Claims.ts CLAIM_TAGS                             *)
(* RequestStatuses <-> src/Requests.ts REQUEST_TAGS                        *)
(* JobStatuses     <-> src/Jobs.ts JOB_TAGS                                *)
(* SpeechStatuses  <-> src/Floor.ts FLOOR_TAGS                             *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Claims,    \* claims people make that the fast check contradicts
          MaxTurns   \* bound on lines heard, to keep the state space finite

\* Vocabulary kept in step with the TypeScript tags (test/SpecSync.test.ts).
ClaimStatuses == {"Fresh", "Checking", "Standing", "Closed"}
RequestStatuses == {"Listening", "Working", "Ready", "Closed"}
JobStatuses == {"Running", "Finished"}
SpeechStatuses == {"Open", "Composing", "Speaking"}

\* input: LineBegan
\* input: LineUnderstood
\* input: LineFailed
\* input: Silence
\* input: PartialHeard
\* input: JobDone
\* input: Composed
\* input: SpeechEnded
\* input: Sweep

VARIABLES
    turn,      \* lines heard so far
    status,    \* claim -> none (not yet) or a ClaimStatuses tag
    intro,     \* claim -> the turn it was said on
    truth,     \* claim -> what a second look would find: "wrong" or "right"
    repaired,  \* claim -> a later line corrected it (Judgments.correctsToday)
    parked,    \* claim -> this claim's resource was parked (Judgments.parksToday)
    told,      \* claim -> a tentative barge already went out
    jobs,      \* claims with a second look in flight
    attempts,  \* claim -> number of confirm/recheck jobs started
    basis,     \* claim -> "none" | "confirmed" | "fastCheck" (src/Ids.ts Basis)
    req,       \* one question to Egg Head
    reqJob,    \* its Investigator answer job is in flight
    floor,     \* SpeechStatuses
    humanSince,\* a human line since Egg Head last spoke (Floor.turnAtLastLine)
    said,      \* claims said out loud
    how,       \* claim -> "firm" or "tentative" (what was said)
    harm       \* ghost: what went wrong when Egg Head spoke

res == [c \in Claims |-> c]  \* each claim is its own resource (src/Claims.ts resource)
vars == <<turn, status, intro, truth, repaired, parked, told, jobs, attempts, basis,
          req, reqJob, floor, humanSince, said, how, harm>>

Open(c) == status[c] \in {"Fresh", "Checking", "Standing"}

\* src/Claims.ts bargeable + bargeVoice; src/Step.ts PartialHeard
HarmOf(c, firm) ==
    (IF firm /\ basis[c] # "confirmed" THEN {"firm unconfirmed"} ELSE {})
    \cup (IF repaired[c] \/ status[c] = "Closed" THEN {"corrected"} ELSE {})
    \cup (IF firm /\ truth[c] = "right" THEN {"claim was right"} ELSE {})

Init ==
    /\ turn = 0
    /\ status = [c \in Claims |-> "none"]
    /\ intro = [c \in Claims |-> 0]
    /\ truth = [c \in Claims |-> "wrong"]
    /\ repaired = [c \in Claims |-> FALSE]
    /\ parked = [c \in Claims |-> FALSE]
    /\ told = [c \in Claims |-> FALSE]
    /\ jobs = {}
    /\ attempts = [c \in Claims |-> 0]
    /\ basis = [c \in Claims |-> "none"]
    /\ req = "none"
    /\ reqJob = FALSE
    /\ floor = "Open"
    /\ humanSince = TRUE
    /\ said = {}
    /\ how = [c \in Claims |-> "none"]
    /\ harm = {}

MaySpeak == floor = "Open"  \* src/Floor.ts mayStart: not while Speaking or Composing

\* ghost: a line started while Egg Head was already speaking (barge-in is exempt by design)
Overlap == IF floor # "Open" THEN {"overlap"} ELSE {}

\* src/Agenda.ts next + src/Claims.ts spoken (flag)
GateItem == {c \in Claims : status[c] = "Standing"}
Oldest == IF GateItem = {} THEN CHOOSE x \in Claims : TRUE
          ELSE CHOOSE c \in GateItem : \A d \in GateItem : intro[c] <= intro[d]

\* src/Step.ts speakTail / Floor.take
SpeakFlag(c) ==
    /\ status[c] = "Standing"
    /\ ~repaired[c]
    /\ ~parked[c]
    /\ MaySpeak
    /\ status' = [status EXCEPT ![c] = "Closed"]
    /\ said' = said \cup {c}
    /\ how' = [how EXCEPT ![c] = IF basis[c] = "confirmed" THEN "firm" ELSE "tentative"]
    /\ floor' = "Speaking"
    /\ humanSince' = FALSE
    /\ harm' = harm \cup HarmOf(c, basis[c] = "confirmed") \cup Overlap
    /\ UNCHANGED <<turn, intro, truth, repaired, parked, told, jobs, attempts, basis, req, reqJob>>

\* src/Requests.ts worked then jobFinished then answered
SpeakAnswer ==
    /\ req = "Ready"
    /\ MaySpeak
    /\ req' = "Closed"
    /\ floor' = "Speaking"
    /\ humanSince' = FALSE
    /\ harm' = harm \cup Overlap
    /\ UNCHANGED <<turn, status, intro, truth, repaired, parked, told, jobs, attempts, basis, reqJob, said, how>>

Ack ==
    /\ req = "Listening"
    /\ MaySpeak
    /\ req' = "Working"
    /\ reqJob' = TRUE
    /\ floor' = "Speaking"
    /\ humanSince' = FALSE
    /\ harm' = harm \cup Overlap
    /\ UNCHANGED <<turn, status, intro, truth, repaired, parked, told, jobs, attempts, basis, said, how>>

Step(floorOpen) ==
    /\ floorOpen
    /\ IF req = "Ready" THEN SpeakAnswer
       ELSE IF req = "Listening" THEN Ack
       ELSE IF GateItem # {} THEN SpeakFlag(Oldest)
       ELSE UNCHANGED vars

(***************************************************************************)
(* input: LineBegan  (src/Step.ts LineBegan)                               *)
(***************************************************************************)
LineBegan ==
    /\ turn < MaxTurns
    /\ UNCHANGED vars

(***************************************************************************)
(* input: LineUnderstood  (src/Step.ts understood)                         *)
(***************************************************************************)
LineKinds == {"other", "repair", "park", "question", "claim"}

\* src/Judgments.ts parksToday: only claims whose resource is named (here: the
\* park names r). src/Claims.ts judge closes them.
ParkNamed(r) ==
    [c \in Claims |-> IF res[c] = r /\ Open(c) THEN TRUE ELSE parked[c]]

Hear(kind, c, found) ==
    /\ turn < MaxTurns
    /\ LET t == turn + 1
           \* src/Judgments.ts correctsToday
           rep == IF kind = "repair" THEN [x \in Claims |-> repaired[x] \/ Open(x)] ELSE repaired
           \* park names c's resource; other resources stay open (finding 6)
           prk == IF kind = "park" THEN ParkNamed(c) ELSE parked
           look == {x \in Claims : status[x] = "Fresh" /\ intro[x] < t}
           s1 == [x \in Claims |->
                    IF rep[x] \/ prk[x] THEN "Closed"
                    ELSE IF x \in look THEN "Checking"
                    ELSE status[x]]
           new == kind = "claim" /\ s1[c] = "none"
           s2 == IF new THEN [s1 EXCEPT ![c] = "Fresh"] ELSE s1
       IN /\ turn' = t
          /\ repaired' = rep
          /\ parked' = prk
          /\ intro' = IF new THEN [intro EXCEPT ![c] = t] ELSE intro
          /\ truth' = IF new THEN [truth EXCEPT ![c] = found] ELSE truth
          /\ jobs' = (jobs \cup look) \ {x \in Claims : s1[x] = "Closed"}
          /\ attempts' = [x \in Claims |-> IF x \in look THEN attempts[x] + 1 ELSE attempts[x]]
          /\ humanSince' = TRUE
          /\ status' = s2
          /\ UNCHANGED basis
          /\ harm' = harm \cup (IF \E x \in Claims : prk[x] /\ ~parked[x] /\ res[x] # c
                                 THEN {"parked other"} ELSE {})
          /\ IF kind = "question" /\ req \in {"none", "Closed"}
             THEN /\ req' = "Listening"
                  /\ UNCHANGED <<reqJob, said, how, floor, told>>
             ELSE /\ UNCHANGED <<req, reqJob, said, how, floor, told>>

HearAny ==
    \/ \E c \in Claims, found \in {"wrong", "right"} : Hear("claim", c, found)
    \/ \E c \in Claims : Hear("other", c, "wrong") \/ Hear("repair", c, "wrong") \/ Hear("park", c, "wrong") \/ Hear("question", c, "wrong")

(***************************************************************************)
(* input: LineFailed  (src/Step.ts LineFailed)                             *)
(***************************************************************************)
LineFailed ==
    /\ turn > 0
    /\ UNCHANGED vars

(***************************************************************************)
(* input: Silence  (src/Step.ts Silence)                                   *)
(***************************************************************************)
Tick(floorOpen) ==
    /\ turn > 0
    /\ floor = "Open"
    /\ Step(floorOpen)
    /\ UNCHANGED <<turn, intro, truth, repaired, parked, told, jobs, attempts, basis>>

(***************************************************************************)
(* input: PartialHeard  (src/Step.ts PartialHeard; src/Claims.ts spoken)   *)
(***************************************************************************)
Barge(c) ==
    /\ Open(c)
    /\ ~repaired[c]
    /\ ~parked[c]
    /\ ~(told[c] /\ basis[c] # "confirmed")  \* src/Claims.ts bargeable
    /\ status[c] # "Closed"
    /\ LET firm == status[c] = "Standing" /\ basis[c] = "confirmed"
       IN /\ said' = said \cup {c}
          /\ how' = [how EXCEPT ![c] = IF firm THEN "firm" ELSE "tentative"]
          /\ told' = [told EXCEPT ![c] = TRUE]
          /\ floor' = "Speaking"
          /\ humanSince' = FALSE
          /\ harm' = harm \cup HarmOf(c, firm)
          /\ IF firm
             THEN /\ status' = [status EXCEPT ![c] = "Closed"]
                  /\ UNCHANGED <<jobs, attempts, basis>>
             ELSE IF status[c] = "Checking" THEN
                  UNCHANGED <<status, jobs, attempts, basis>>
             ELSE /\ status' = [status EXCEPT ![c] = "Checking"]
                  /\ jobs' = jobs \cup {c}
                  /\ attempts' = [attempts EXCEPT ![c] = 1]
                  /\ UNCHANGED basis
          /\ UNCHANGED <<turn, intro, truth, repaired, parked, req, reqJob>>

(***************************************************************************)
(* input: JobDone  (src/Claims.ts jobFinished, src/Requests.ts jobFinished)*)
(***************************************************************************)
Report(c, outcome) ==
    /\ c \in jobs
    /\ \/ outcome \in {"failed", "unknown"}
       \/ (outcome = "wrong" /\ truth[c] = "wrong")
       \/ (outcome = "right" /\ truth[c] = "right")
    /\ IF status[c] # "Checking" THEN
           /\ jobs' = jobs \ {c}
           /\ UNCHANGED <<status, told, attempts, basis>>
       ELSE IF outcome \in {"right", "unknown"} THEN
           /\ jobs' = jobs \ {c}
           /\ status' = [status EXCEPT ![c] = "Closed"]
           /\ UNCHANGED <<told, attempts, basis>>
       ELSE IF outcome = "failed" /\ attempts[c] <= 1 THEN
           /\ jobs' = jobs
           /\ attempts' = [attempts EXCEPT ![c] = 2]
           /\ UNCHANGED <<status, told, basis>>
       ELSE IF outcome = "wrong" THEN
           /\ jobs' = jobs \ {c}
           /\ status' = [status EXCEPT ![c] = "Standing"]
           /\ basis' = [basis EXCEPT ![c] = "confirmed"]
           /\ UNCHANGED <<told, attempts>>
       ELSE
           /\ jobs' = jobs \ {c}
           /\ status' = [status EXCEPT ![c] = "Standing"]
           /\ basis' = [basis EXCEPT ![c] = "fastCheck"]
           /\ UNCHANGED <<told, attempts>>
    /\ UNCHANGED <<turn, intro, truth, repaired, parked, req, reqJob, floor, humanSince, said, how, harm>>

Answer(outcome) ==
    /\ reqJob
    /\ req = "Working"
    /\ reqJob' = FALSE
    /\ req' = "Ready"     \* found, unknown, or failed: always a line to say (src/Requests.ts)
    /\ UNCHANGED <<turn, status, intro, truth, repaired, parked, told, jobs, attempts, basis, floor, humanSince, said, how, harm>>

(***************************************************************************)
(* input: Composed  (src/Step.ts Composed)                                 *)
(***************************************************************************)
Composed ==
    /\ floor = "Composing"
    /\ floor' = "Speaking"
    /\ UNCHANGED <<turn, status, intro, truth, repaired, parked, told, jobs, attempts, basis, req, reqJob, humanSince, said, how, harm>>

(***************************************************************************)
(* input: SpeechEnded  (src/Floor.ts ended)                                *)
(***************************************************************************)
SpeechEnded ==
    /\ floor = "Speaking"
    /\ floor' = "Open"
    /\ UNCHANGED <<turn, status, intro, truth, repaired, parked, told, jobs, attempts, basis, req, reqJob, humanSince, said, how, harm>>

(***************************************************************************)
(* input: Sweep  (src/Step.ts sweep; job deadline)                         *)
(***************************************************************************)
Sweep ==
    \E c \in jobs : Report(c, "failed")

Next ==
    \/ HearAny
    \/ Tick(TRUE)
    \/ \E c \in Claims : Barge(c)
    \/ \E c \in Claims, outcome \in {"wrong", "right", "unknown", "failed"} : Report(c, outcome)
    \/ \E outcome \in {"found", "unknown", "failed"} : Answer(outcome)
    \/ SpeechEnded
    \/ Sweep
    \* LineBegan, LineFailed and Composed are identity or rare; cited above as comments so SpecSync
    \* still sees the input tags. Enabling them as stuttering actions explodes the state space.

Fairness ==
    /\ SF_vars(Tick(TRUE))
    /\ SF_vars(SpeechEnded)
    /\ \A c \in Claims : WF_vars(\E outcome \in {"wrong", "right", "unknown", "failed"} : Report(c, outcome))
    /\ WF_vars(\E outcome \in {"found", "unknown", "failed"} : Answer(outcome))

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* What the people on the call should be able to rely on.                  *)
(***************************************************************************)

TypeOK ==
    /\ turn \in 0..MaxTurns
    /\ status \in [Claims -> ClaimStatuses \cup {"none"}]
    /\ req \in RequestStatuses \cup {"none"}
    /\ floor \in SpeechStatuses
    /\ said \subseteq Claims
    /\ jobs \subseteq Claims

\* src/Claims.ts bargeVoice, src/Step.ts speakTail: a tentative barge on an unconfirmed claim is allowed.
NeverFirmOnUnconfirmed == "firm unconfirmed" \notin harm

\* src/Claims.ts bargeable; corrected and parked claims are Closed
NeverSaysCorrected == "corrected" \notin harm

\* src/Claims.ts jobFinished: a claim the agent finds right is Closed (overruled)
NeverSaysRightClaimIsWrong == "claim was right" \notin harm

\* src/Claims.ts spoken: a tentative barge starts a confirm job
TentativeIsChecked == \A c \in Claims : told[c] => status[c] \in {"Checking", "Standing", "Closed"}

\* src/Claims.ts judge + src/Judgments.ts parksToday: a park of r never closes a claim about another resource.
ParkingIsScoped == "parked other" \notin harm

\* src/Floor.ts mayStart: no flag, ack or answer starts while Egg Head is speaking. The quiet-time
\* half of the rule (quietAfterSpeechS) is timing and is not modelled; barge-in is exempt.
OneLinePerGap == "overlap" \notin harm

\* src/Requests.ts jobFinished always reaches Ready, then Agenda answers.
AckIsAnswered == (req = "Working") ~> (req = "Closed")

\* src/Claims.ts Standing is spoken or closed (overruled, parked, repaired).
ConfirmedIsResolved == \A c \in Claims : (status[c] = "Standing") ~> (status[c] = "Closed")

=============================================================================
