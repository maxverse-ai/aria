-------------------------- MODULE ResultCheckpoint --------------------------
VARIABLE phase, durable, outputAvailable
vars == <<phase, durable, outputAvailable>>
Init == /\ phase = "running" /\ durable = FALSE /\ outputAvailable = TRUE
Complete == /\ phase = "running" /\ phase' = "succeeded"
            /\ UNCHANGED <<durable, outputAvailable>>
Checkpoint == /\ phase = "succeeded" /\ outputAvailable /\ ~durable
              /\ durable' = TRUE /\ UNCHANGED <<phase, outputAvailable>>
LoseVolatile == /\ phase = "succeeded" /\ ~durable /\ outputAvailable
                /\ outputAvailable' = FALSE /\ UNCHANGED <<phase, durable>>
Next == Complete \/ Checkpoint \/ LoseVolatile
RecoverableOutput == phase = "succeeded" => durable \/ outputAvailable
=============================================================================
