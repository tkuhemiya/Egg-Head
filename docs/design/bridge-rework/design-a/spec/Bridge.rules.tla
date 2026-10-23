\* Changes to spec/Bridge.tla for the W3 design. Only what differs; the rest of the model stands.
\*
\* HEADER TABLE (parsed by test/Laws.test.ts; keep one row per code tag)
\*   status "none"       -
\*   status "pending"    Claims.Phase Fresh
\*   status "checking"   Claims.Phase Checking          (a Job row is Running)
\*   status "confirmed"  Claims.Phase Standing          (basis confirmed | fastCheck)
\*   status "spoken"     Claims.Phase Closed{Spoken}
\*   status "closed"     Claims.Phase Closed{Corrected|Overruled|Parked|Undetermined|Unverifiable}
\*   action Hear=LineUnderstood Tick=Silence Barge=PartialHeard Report=JobDone Answer=JobDone Spoke=SpeechEnded

VARIABLES res,      \* claim -> resource
          told,     \* claim -> TRUE once said tentatively
          egg,      \* "open" | "speaking"
          humanSince \* a human line was heard since Egg Head's last line

\* "said" now records HOW: said[c] \in {"firm","tentative"}. Harm (ghost) is split:
HarmOf(c, how) ==
    (IF how = "firm" /\ status[c] # "confirmed" /\ ~directMode THEN {"firm unconfirmed"} ELSE {})
    \cup (IF repaired[c] \/ status[c] = "closed" THEN {"corrected"} ELSE {})
    \cup (IF how = "firm" /\ truth[c] = "right" THEN {"claim was right"} ELSE {})

\* Owner's rule, replacing NeverSaysUnconfirmed: a tentative barge on an unconfirmed claim is allowed;
\* firm on unconfirmed never; any speech about a corrected claim never.
NeverFirmOnUnconfirmed == "firm unconfirmed" \notin harm
NeverSaysCorrected == "corrected" \notin harm
NeverSaysRightClaimIsWrong == "claim was right" \notin harm      \* firm only

\* Barge(c, how): requires Open(c) \/ status[c] = "pending"; how = "tentative" unless status[c] = "confirmed";
\* a tentative barge on a pending claim sets status[c]' = "checking" and jobs' = jobs \cup {c}  (the promise is a job).
TentativeIsChecked == \A c \in Claims : told[c] => status[c] \in {"checking", "confirmed", "spoken", "closed"}

\* Park(r): a parking line closes ONLY claims with res[c] = r that are open.
Park(r) == status' = [c \in Claims |-> IF res[c] = r /\ Open(c) THEN "closed" ELSE status[c]]
ParkingIsScoped == [][\A c \in Claims : (status[c] # status'[c] /\ status'[c] = "closed" /\ parkedNow') => res[c] \in parkedRes']_vars

\* Report(c, outcome) with outcome \in {"wrong","right","unknown","failed"}: unknown closes quietly;
\* failed starts a recheck (stays "checking") once, then closes (unverifiable) or becomes "confirmed" with basis fastCheck.
\* Answer(outcome) is total: found | unknown | failed all end with req = "ready" (an unable line), then "answered".
AckIsAnswered == (req = "checking") ~> (req = "answered")          \* now true: Answer cannot leave req = "checking"
ConfirmedIsResolved == \A c \in Claims : (status[c] = "confirmed") ~> (status[c] \in {"spoken", "closed"})

\* One line per gap. Every speech sets egg' = "speaking", humanSince' = FALSE; SpeechEnded sets egg' = "open";
\* a speech requires egg = "open" /\ (humanSince \/ quietElapsed). Safety: never two speeches without that.
OneLinePerGap == [][(egg = "speaking" \/ ~(humanSince \/ quietElapsed)) => said' = said]_vars
\* Fairness adds WF on SpeechEnded and on Sweep (deadlines), so Speaking and Running cannot last forever.
