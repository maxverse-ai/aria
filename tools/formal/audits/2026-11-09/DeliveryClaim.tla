--------------------------- MODULE DeliveryClaim ---------------------------
EXTENDS Naturals, FiniteSets
VARIABLE readReady, sent, completed
vars == <<readReady, sent, completed>>
Init == /\ readReady = {} /\ sent = {} /\ completed = FALSE
Read(c) == /\ ~completed /\ c \notin readReady
           /\ readReady' = readReady \cup {c} /\ UNCHANGED <<sent, completed>>
Send(c) == /\ c \in readReady /\ c \notin sent
           /\ sent' = sent \cup {c} /\ UNCHANGED <<readReady, completed>>
Commit == /\ sent # {} /\ ~completed /\ completed' = TRUE
          /\ UNCHANGED <<readReady, sent>>
Next == (\E c \in {1, 2}: Read(c) \/ Send(c)) \/ Commit
SingleDispatch == Cardinality(sent) <= 1
=============================================================================
