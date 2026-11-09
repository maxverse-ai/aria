----------------------------- MODULE PoolHandoff -----------------------------
EXTENDS Naturals
CONSTANT TransferPermit
VARIABLES active, waiter, newcomer, first
vars == <<active, waiter, newcomer, first>>
Init == /\ active = 1 /\ waiter = "queued" /\ newcomer = FALSE /\ first = TRUE
Release == /\ first /\ first' = FALSE /\ waiter' = "woken"
           /\ active' = IF TransferPermit THEN active ELSE active - 1
           /\ UNCHANGED newcomer
Newcomer == /\ ~newcomer /\ active < 1
            /\ newcomer' = TRUE /\ active' = active + 1
            /\ UNCHANGED <<waiter, first>>
Continue == /\ waiter = "woken" /\ waiter' = "running"
            /\ active' = IF TransferPermit THEN active ELSE active + 1
            /\ UNCHANGED <<newcomer, first>>
Next == Release \/ Newcomer \/ Continue
Capacity == active <= 1
=============================================================================
