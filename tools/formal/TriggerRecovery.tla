------------------------- MODULE TriggerRecovery -------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS DurableOutput, GuardUnknown, EnforceQuota
VARIABLES state, accepted, output, outbox, routed, admitted
vars == <<state, accepted, output, outbox, routed, admitted>>
Init == /\ state = "pending" /\ accepted = 0 /\ output = FALSE
        /\ outbox = FALSE /\ routed = FALSE /\ admitted = {}
Admit(i) == /\ i \in {1, 2} /\ i \notin admitted
            /\ (~EnforceQuota \/ Cardinality(admitted) < 1)
            /\ admitted' = admitted \cup {i}
            /\ UNCHANGED <<state, accepted, output, outbox, routed>>
Submit == /\ state = "pending" /\ state' = "running" /\ accepted' = accepted + 1
          /\ UNCHANGED <<output, outbox, routed, admitted>>
LoseObserver == /\ state = "running"
                /\ state' = IF GuardUnknown THEN "unknown" ELSE "pending"
                /\ UNCHANGED <<accepted, output, outbox, routed, admitted>>
Complete == /\ state = "running" /\ state' = "succeeded"
            /\ output' = TRUE /\ outbox' = DurableOutput
            /\ UNCHANGED <<accepted, routed, admitted>>
Route == /\ state = "succeeded" /\ output /\ ~routed
         /\ routed' = TRUE /\ outbox' = FALSE
         /\ UNCHANGED <<state, accepted, output, admitted>>
Crash == /\ state = "succeeded" /\ ~DurableOutput /\ output
         /\ output' = FALSE /\ UNCHANGED <<state, accepted, outbox, routed, admitted>>
ReconcileSuccess == /\ state = "unknown" /\ state' = "succeeded"
                    /\ output' = TRUE /\ outbox' = TRUE
                    /\ UNCHANGED <<accepted, routed, admitted>>
Next == (\E i \in {1, 2}: Admit(i)) \/ Submit \/ LoseObserver \/ Complete \/ Route \/ Crash \/ ReconcileSuccess
NoLostOutput == state = "succeeded" => (outbox \/ routed)
NoBlindReplay == accepted <= 1
DailyQuota == Cardinality(admitted) <= 1
=============================================================================
