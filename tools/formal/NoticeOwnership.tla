-------------------------- MODULE NoticeOwnership --------------------------
EXTENDS Naturals
CONSTANT Guard
VARIABLES pending, mail, held, delivered
vars == <<pending, mail, held, delivered>>
Init == /\ pending = "claimed" /\ mail = "pending" /\ held = FALSE /\ delivered = 0
Claim == /\ mail = "pending" /\ ~held /\ held' = TRUE /\ UNCHANGED <<pending, mail, delivered>>
Pull == /\ held /\ mail = "pending" /\ mail' = "pulled" /\ held' = FALSE
        /\ delivered' = delivered + 1 /\ UNCHANGED pending
Reject == /\ pending = "claimed"
          /\ pending' = IF Guard /\ (held \/ mail # "pending") THEN "ack" ELSE "queued"
          /\ mail' = IF ~held /\ mail = "pending" THEN "dropped" ELSE mail
          /\ UNCHANGED <<held, delivered>>
NextTurn == /\ pending = "queued" /\ pending' = "ack" /\ delivered' = delivered + 1
            /\ UNCHANGED <<mail, held>>
Expire == /\ mail = "pending" /\ ~held /\ mail' = "expired" /\ UNCHANGED <<pending, held, delivered>>
Redeposit == /\ mail \in {"pulled", "dropped", "expired"} /\ UNCHANGED vars
Next == Claim \/ Pull \/ Reject \/ NextTurn \/ Expire \/ Redeposit
NoDuplicate == delivered <= 1
NoResurrection == mail \in {"dropped", "expired"} => ~held
=============================================================================
