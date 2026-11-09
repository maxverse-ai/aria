---------------------------- MODULE MailboxConsumers ----------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Consumers, AtomicClaim
VARIABLES state, pc, delivered
vars == <<state, pc, delivered>>
Init == /\ state = "unread" /\ pc = [c \in Consumers |-> "idle"] /\ delivered = {}
Read(c) == /\ pc[c] = "idle" /\ state = "unread"
           /\ pc' = [pc EXCEPT ![c] = "snapshot"]
           /\ state' = IF AtomicClaim THEN c ELSE state
           /\ UNCHANGED delivered
Mark(c) == /\ pc[c] = "snapshot"
           /\ pc' = [pc EXCEPT ![c] = "marked"]
           /\ state' = IF state = "unread" THEN c ELSE state
           /\ UNCHANGED delivered
Return(c) == /\ pc[c] = "marked" /\ pc' = [pc EXCEPT ![c] = "done"]
             /\ delivered' = delivered \cup {c} /\ UNCHANGED state
Next == \E c \in Consumers : Read(c) \/ Mark(c) \/ Return(c)
SingleConsumer == Cardinality(delivered) <= 1
=============================================================================
