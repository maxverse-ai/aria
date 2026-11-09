------------------------- MODULE ResultDeliveryClaim -------------------------
EXTENDS Naturals
CONSTANT Guard
VARIABLES state, owner, held, sent, generation
vars == <<state, owner, held, sent, generation>>
Actors == {1, 2}
Init == /\ state = "pending" /\ owner = 0 /\ held = {} /\ sent = 0 /\ generation = 1
Claim(a) == /\ state = "pending" /\ a \notin held
            /\ held' = held \cup {a}
            /\ IF Guard THEN /\ state' = "delivering" /\ owner' = a
                        ELSE UNCHANGED <<state, owner>>
            /\ UNCHANGED <<sent, generation>>
Send(a) == /\ a \in held /\ (~Guard \/ (state = "delivering" /\ owner = a))
           /\ sent' = sent + 1 /\ held' = held \ {a}
           /\ state' = "uncertain" /\ UNCHANGED <<owner, generation>>
Resolve == /\ state = "uncertain" /\ state' = "closed"
           /\ generation' = generation + 1 /\ owner' = 0
           /\ UNCHANGED <<sent, held>>
StaleSettlement == /\ state = "closed" /\ held # {} /\ ~Guard
                   /\ state' = "pending" /\ UNCHANGED <<owner, held, sent, generation>>
Next == (\E a \in Actors : Claim(a) \/ Send(a)) \/ Resolve \/ StaleSettlement
SingleDispatch == sent <= 1
=============================================================================
