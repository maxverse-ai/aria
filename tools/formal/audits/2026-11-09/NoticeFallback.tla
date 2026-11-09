---------------- MODULE NoticeFallback ----------------
EXTENDS Naturals
VARIABLES pending, mail, delivered
vars == <<pending,mail,delivered>>
Init == /\ pending="claimed" /\ mail="absent" /\ delivered=0
Deposit == /\ mail="absent" /\ mail'="pending" /\ UNCHANGED <<pending,delivered>>
Pull == /\ mail="pending" /\ mail'="pulled" /\ delivered'=delivered+1 /\ UNCHANGED pending
RejectNotice == /\ mail \in {"pending","pulled"} /\ pending="claimed"
                /\ pending'="queued" /\ mail'=(IF mail="pending" THEN "dropped" ELSE mail) /\ UNCHANGED delivered
RunNext == /\ pending="queued" /\ pending'="done" /\ delivered'=delivered+1 /\ UNCHANGED mail
Next == Deposit \/ Pull \/ RejectNotice \/ RunNext
NoDuplicate == delivered <= 1
======================================================
