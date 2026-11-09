-------------------------- MODULE ReliabilityLease --------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Guarded
Actors == {1, 2}
VARIABLES owner, expired, protected, phase, calls, checkpoint, completed, dead
vars == <<owner, expired, protected, phase, calls, checkpoint, completed, dead>>
Init == /\ owner = 0 /\ expired = FALSE /\ protected = FALSE
        /\ phase = [a \in Actors |-> "idle"] /\ calls = {} /\ checkpoint = FALSE
        /\ completed = FALSE /\ dead = {}
Claim(a) == /\ phase[a] = "idle" /\ ~completed
            /\ (owner = 0 \/ (expired /\ ~protected))
            /\ owner' = a /\ expired' = FALSE /\ protected' = Guarded
            /\ phase' = [phase EXCEPT ![a] = "claimed"]
            /\ UNCHANGED <<calls, checkpoint, completed, dead>>
Expire == /\ owner # 0 /\ ~expired /\ expired' = TRUE
          /\ UNCHANGED <<owner, protected, phase, calls, checkpoint, completed, dead>>
Process(a) == /\ phase[a] = "claimed" /\ a \notin dead
              /\ (~Guarded \/ owner = a)
              /\ phase' = [phase EXCEPT ![a] = "processing"]
              /\ calls' = IF checkpoint THEN calls ELSE calls \cup {a}
              /\ UNCHANGED <<owner, expired, protected, checkpoint, completed, dead>>
Checkpoint(a) == /\ phase[a] = "processing" /\ a \notin dead
                 /\ (~Guarded \/ owner = a)
                 /\ checkpoint' = TRUE /\ phase' = [phase EXCEPT ![a] = "saved"]
                 /\ UNCHANGED <<owner, expired, protected, calls, completed, dead>>
Complete(a) == /\ phase[a] = "saved" /\ a \notin dead /\ (~Guarded \/ owner = a)
               /\ completed' = TRUE /\ phase' = [phase EXCEPT ![a] = "done"]
               /\ owner' = 0 /\ protected' = FALSE
               /\ UNCHANGED <<expired, calls, checkpoint, dead>>
Crash(a) == /\ a = owner /\ a \notin dead /\ dead' = dead \cup {a}
            /\ UNCHANGED <<owner, expired, protected, phase, calls, checkpoint, completed>>
Reconcile == /\ owner \in dead /\ checkpoint /\ owner' = 0 /\ protected' = FALSE
             /\ UNCHANGED <<expired, phase, calls, checkpoint, completed, dead>>
Next == Expire \/ Reconcile \/ (\E a \in Actors: Claim(a) \/ Process(a) \/ Checkpoint(a) \/ Complete(a) \/ Crash(a))
NoDuplicateProcessor == Cardinality(calls) <= 1
CompletionHasAnswer == completed => checkpoint
HealthyNext == Expire \/ (\E a \in Actors: Claim(a) \/ Process(a) \/ Checkpoint(a) \/ Complete(a))
HealthySpec == Init /\ [][HealthyNext]_vars /\ WF_vars(HealthyNext)
EventuallyCompleted == <>completed
Spec == Init /\ [][Next]_vars
=============================================================================
