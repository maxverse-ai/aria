-------------------------- MODULE RunningRecovery --------------------------
VARIABLE phase, expired, recovered
vars == <<phase, expired, recovered>>
Init == /\ phase = "running" /\ expired = FALSE /\ recovered = FALSE
Expire == /\ ~expired /\ expired' = TRUE /\ UNCHANGED <<phase, recovered>>
Claim == /\ expired /\ ~recovered /\ recovered' = TRUE /\ expired' = FALSE
         /\ UNCHANGED phase
BeginDispatch == /\ recovered /\ phase \in {"leased", "dispatching"}
                 /\ phase' = "dispatching" /\ UNCHANGED <<expired, recovered>>
Next == Expire \/ Claim \/ BeginDispatch
RecoveryCanAdvance == recovered => phase \in {"leased", "dispatching"}
=============================================================================
