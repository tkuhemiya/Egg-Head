------------------------------- MODULE Bridge -------------------------------
(***************************************************************************)
(* When does Egg Head speak? A model of src/Bridge.ts in agent mode (with *)
(* an Investigator).                                                       *)
(*                                                                         *)
(* Every Bridge entry point (hear, tick, partial, an Investigator result)  *)
(* runs under one Semaphore, so each is one atomic action here. What the   *)
(* model leaves to chance is what the call and the models decide: what    *)
(* each line is, whether the floor is open at a gap (Decider's finished    *)
(* score, silence, cooldown), whether a partial transcript sounds like an  *)
(* order to act, and what the Investigator finds.                          *)
(*                                                                         *)
(* Claim status here maps onto LedgerItem (src/Ledger.ts):                 *)
(*   "none"       not said yet                                             *)
(*   "pending"    contradicted by the fast check     agent: "pending"      *)
(*   "checking"   second look running                agent: "checking"     *)
(*   "confirmed"  second look agrees it is wrong     agent: "confirmed"    *)
(*   "spoken"     Egg Head said it (flag or barge)   raised: true          *)
(*   "closed"     dropped without speaking: corrected by the call, or the  *)
(*                agent found the claim was right    raised: true          *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Claims,    \* claims people make that the fast check contradicts
          MaxTurns   \* bound on lines heard, to keep the state space finite

VARIABLES
    turn,      \* lines heard so far (BridgeState.turns length)
    status,    \* claim -> status above
    intro,     \* claim -> the turn it was said on (LedgerItem.turn)
    truth,     \* claim -> what a second look would find: "wrong" or "right"
    repaired,  \* claim -> a later line corrected it (Gate.ts REPAIR on laterTurns)
    parked,    \* claim -> a later line parked a topic (Gate.ts PARKED on laterTurns)
    jobs,      \* claims with a second look in flight (Bridge.ts background)
    req,       \* one question to Egg Head (Conversation.ts RequestState, plus "none")
    reqJob,    \* its Investigator answer job is in flight
    said,      \* claims Egg Head has said out loud
    harm       \* ghost: what went wrong when Egg Head spoke (for the invariants)

vars == <<turn, status, intro, truth, repaired, parked, jobs, req, reqJob, said, harm>>

Open(c) == status[c] \in {"pending", "checking", "confirmed"}

\* What it would mean if Egg Head said claim c right now.
HarmOf(c) ==
    (IF status[c] # "confirmed" THEN {"unconfirmed"} ELSE {})
    \cup (IF repaired[c] THEN {"corrected"} ELSE {})
    \cup (IF truth[c] = "right" THEN {"claim was right"} ELSE {})

Init ==
    /\ turn = 0
    /\ status = [c \in Claims |-> "none"]
    /\ intro = [c \in Claims |-> 0]
    /\ truth = [c \in Claims |-> "wrong"]
    /\ repaired = [c \in Claims |-> FALSE]
    /\ parked = [c \in Claims |-> FALSE]
    /\ jobs = {}
    /\ req = "none"
    /\ reqJob = FALSE
    /\ said = {}
    /\ harm = {}

(***************************************************************************)
(* The speaking decision of one step (Bridge.ts step): converse first,     *)
(* then the claim gate. `floor` is whether the gap allows speaking now.    *)
(***************************************************************************)

\* Bridge.ts gateItem: the oldest claim the Investigator confirmed.
Confirmed(st) == {c \in Claims : st[c] = "confirmed"}
GateItem(st, it) == CHOOSE c \in Confirmed(st) : \A d \in Confirmed(st) : it[c] <= it[d]

\* Bridge.ts decide + Gate.ts decide, given the step's claim statuses `st`.
\* Returns the claim statuses after the step and the claim spoken (or "").
Decide(st, floor) ==
    IF Confirmed(st) = {} THEN [st |-> st, spoke |-> ""]
    ELSE LET g == GateItem(st, intro) IN
         IF repaired[g] THEN [st |-> [st EXCEPT ![g] = "closed"], spoke |-> ""]   \* Bridge.ts:193-196
         ELSE IF parked[g] THEN [st |-> st, spoke |-> ""]                          \* Gate.ts costLevel 1: worth_it fails
         ELSE IF floor THEN [st |-> [st EXCEPT ![g] = "spoken"], spoke |-> g]      \* Bridge.ts:186-191
         ELSE [st |-> st, spoke |-> ""]

\* Bridge.ts converse: a ready answer, or an ack to a finished question, takes the step.
Converse(floor) == floor /\ req \in {"ready", "listening"}

\* Apply one step to claim statuses `st` (already updated by the caller).
Step(st, floor) ==
    IF Converse(floor)
    THEN /\ req' = IF req = "ready" THEN "answered" ELSE "checking"         \* Bridge.ts:301-331
         /\ reqJob' = (reqJob \/ req = "listening")
         /\ status' = st
         /\ UNCHANGED <<said, harm>>
    ELSE LET d == Decide(st, floor) IN
         /\ status' = d.st
         /\ said' = IF d.spoke = "" THEN said ELSE said \cup {d.spoke}
         /\ harm' = IF d.spoke = "" THEN harm ELSE harm \cup HarmOf(d.spoke)
         /\ UNCHANGED <<req, reqJob>>

(***************************************************************************)
(* hear: one finished line (Bridge.ts:361-494).                            *)
(***************************************************************************)

LineKinds == {"other", "repair", "park", "question"}

Hear(kind, c, found, floor) ==
    /\ turn < MaxTurns
    /\ LET t   == turn + 1
           \* the new line is already in turns (Bridge.ts:363), so it counts as a later turn
           rep == IF kind = "repair" THEN [x \in Claims |-> repaired[x] \/ status[x] # "none"] ELSE repaired
           prk == IF kind = "park" THEN [x \in Claims |-> parked[x] \/ status[x] # "none"] ELSE parked
           \* second look for claims that survived a turn (Bridge.ts:408-428)
           look == {x \in Claims : status[x] = "pending" /\ intro[x] < t}
           s1 == [x \in Claims |-> IF x \in look THEN (IF rep[x] THEN "closed" ELSE "checking") ELSE status[x]]
           \* a new contradicted claim (Bridge.ts:439-453)
           new == kind = "claim" /\ s1[c] = "none"
           s2 == IF new THEN [s1 EXCEPT ![c] = "pending"] ELSE s1
       IN /\ turn' = t
          /\ repaired' = rep
          /\ parked' = prk
          /\ intro' = IF new THEN [intro EXCEPT ![c] = t] ELSE intro
          /\ truth' = IF new THEN [truth EXCEPT ![c] = found] ELSE truth
          /\ jobs' = jobs \cup {x \in look : ~rep[x]}
          \* a question to Egg Head opens a request (Bridge.ts:468-474)
          /\ LET r == IF kind = "question" /\ req = "none" THEN "listening" ELSE req
             IN IF kind = "question" /\ req = "none"
                THEN /\ req' = r
                     /\ status' = s2
                     /\ UNCHANGED <<reqJob, said, harm>>
                ELSE Step(s2, floor)

HearAny ==
    \E kind \in LineKinds \cup {"claim"}, c \in Claims, found \in {"wrong", "right"}, floor \in BOOLEAN :
        Hear(kind, c, found, floor)

(***************************************************************************)
(* tick: more silence, no new line (Bridge.ts:499-515).                    *)
(***************************************************************************)

Tick(floor) ==
    /\ turn > 0
    /\ Step(status, floor)
    /\ UNCHANGED <<turn, intro, truth, repaired, parked, jobs>>

(***************************************************************************)
(* partial: a live partial transcript names claim c's resource and Decider *)
(* says the speaker is telling someone to act now (Bridge.ts:520-554).     *)
(* The code takes any open ledger item.                                    *)
(***************************************************************************)

Barge(c) ==
    /\ Open(c)
    /\ status' = [status EXCEPT ![c] = "spoken"]
    /\ said' = said \cup {c}
    /\ harm' = harm \cup HarmOf(c)
    /\ UNCHANGED <<turn, intro, truth, repaired, parked, jobs, req, reqJob>>

(***************************************************************************)
(* An Investigator result comes back under the lock (Bridge.ts:208-262).   *)
(* "failed": the agent timed out or crashed; the fallback keeps the fast   *)
(* check's status, so the claim counts as confirmed (Bridge.ts:230).       *)
(***************************************************************************)

Report(c, failed) ==
    /\ c \in jobs
    /\ jobs' = jobs \ {c}
    /\ status' = IF status[c] # "checking" THEN status                     \* already raised: note only
                 ELSE IF failed \/ truth[c] = "wrong" THEN [status EXCEPT ![c] = "confirmed"]
                 ELSE [status EXCEPT ![c] = "closed"]                      \* overruled
    /\ UNCHANGED <<turn, intro, truth, repaired, parked, req, reqJob, said, harm>>

(***************************************************************************)
(* The answer job (Bridge.ts:265-288). If the agent fails and the direct   *)
(* fallback fails too (no resource named), background logs the error and  *)
(* nothing changes the request (Bridge.ts:223).                            *)
(***************************************************************************)

Answer(ok) ==
    /\ reqJob
    /\ reqJob' = FALSE
    /\ req' = IF ok /\ req = "checking" THEN "ready" ELSE req
    /\ UNCHANGED <<turn, status, intro, truth, repaired, parked, jobs, said, harm>>

Next ==
    \/ HearAny
    \/ \E floor \in BOOLEAN : Tick(floor)
    \/ \E c \in Claims : Barge(c)
    \/ \E c \in Claims, failed \in BOOLEAN : Report(c, failed)
    \/ \E ok \in BOOLEAN : Answer(ok)

\* The call keeps having gaps, and jobs finish. Barge-in and new lines are not forced.
Fairness ==
    /\ WF_vars(Tick(TRUE))
    /\ \A c \in Claims : WF_vars(\E failed \in BOOLEAN : Report(c, failed))
    /\ WF_vars(\E ok \in BOOLEAN : Answer(ok))

Spec == Init /\ [][Next]_vars /\ Fairness

(***************************************************************************)
(* What the people on the call should be able to rely on.                  *)
(***************************************************************************)

TypeOK ==
    /\ turn \in 0..MaxTurns
    /\ status \in [Claims -> {"none", "pending", "checking", "confirmed", "spoken", "closed"}]
    /\ req \in {"none", "listening", "checking", "ready", "answered"}
    /\ said \subseteq Claims

\* "Egg Head never interrupts with a fast-check result nobody looked at twice."
NeverSaysUnconfirmed == "unconfirmed" \notin harm

\* "Egg Head never raises something the call already corrected."
NeverSaysCorrected == "corrected" \notin harm

\* "Egg Head never tells someone they are wrong when they were right."
NeverSaysRightClaimIsWrong == "claim was right" \notin harm

\* "When Egg Head says 'On it', it comes back with an answer."
AckIsAnswered == (req = "checking") ~> (req = "answered")

\* "A confirmed wrong claim is eventually said or dropped; one claim never blocks another."
ConfirmedIsResolved == \A c \in Claims : (status[c] = "confirmed") ~> (status[c] \in {"spoken", "closed"})

=============================================================================
