----------------------------- MODULE CallbackAck -----------------------------
CONSTANT Background
VARIABLES pc, ack, io
vars == <<pc, ack, io>>
Init == /\ pc = "received" /\ ack = FALSE /\ io = FALSE
Dispatch == /\ pc = "received" /\ pc' = "dispatched"
            /\ ack' = Background /\ UNCHANGED io
StartIO == /\ pc = "dispatched" /\ pc' = "waiting" /\ io' = TRUE
           /\ UNCHANGED ack
Finish == /\ pc = "waiting" /\ pc' = "done" /\ ack' = TRUE /\ UNCHANGED io
Next == Dispatch \/ StartIO \/ Finish
AckBeforeIO == io => ack
=============================================================================
