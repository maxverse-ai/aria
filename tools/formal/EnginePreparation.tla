-------------------------- MODULE EnginePreparation --------------------------
EXTENDS Naturals
CONSTANT Guard
VARIABLES phase, stopped, submitted, bad
vars == <<phase, stopped, submitted, bad>>
Init == /\ phase = "preparing" /\ stopped = FALSE /\ submitted = FALSE /\ bad = FALSE
Stop == /\ ~stopped /\ stopped' = TRUE /\ UNCHANGED <<phase, submitted, bad>>
Prepared == /\ phase = "preparing" /\ phase' = "ready" /\ UNCHANGED <<stopped, submitted, bad>>
Submit == /\ phase = "ready" /\ (~Guard \/ ~stopped)
          /\ phase' = "submitted" /\ submitted' = TRUE /\ bad' = stopped
          /\ UNCHANGED stopped
Cancel == /\ phase \in {"preparing", "ready"} /\ Guard /\ stopped /\ phase' = "terminal"
          /\ UNCHANGED <<stopped, submitted, bad>>
Next == Stop \/ Prepared \/ Submit \/ Cancel
SafeSubmission == ~bad
=============================================================================
