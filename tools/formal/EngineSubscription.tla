-------------------------- MODULE EngineSubscription --------------------------
EXTENDS Naturals
CONSTANT PerConnection
VARIABLES connection, watched, closed, attached
vars == <<connection, watched, closed, attached>>
Init == /\ connection = 1 /\ watched = FALSE /\ closed = FALSE /\ attached = 0
Attach == /\ ~closed /\ ~watched /\ watched' = TRUE /\ attached' = connection
          /\ UNCHANGED <<connection, closed>>
Close == /\ ~closed /\ watched /\ closed' = TRUE
         /\ watched' = IF PerConnection THEN FALSE ELSE watched
         /\ UNCHANGED <<connection, attached>>
Reconnect == /\ closed /\ connection = 1 /\ connection' = 2 /\ closed' = FALSE
             /\ attached' = 0 /\ UNCHANGED watched
Next == Attach \/ Close \/ Reconnect
WatchMatchesConnection == ~closed /\ watched => attached = connection
=============================================================================
