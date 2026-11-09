--------------------------- MODULE EngineTransport ---------------------------
EXTENDS Naturals
CONSTANT GuardEOF
VARIABLES eof, closed, pending, response
vars == <<eof, closed, pending, response>>
Init == /\ eof = FALSE /\ closed = FALSE /\ pending = TRUE /\ response = FALSE
Response == /\ ~eof /\ pending /\ pending' = FALSE /\ response' = TRUE
            /\ UNCHANGED <<eof, closed>>
EOF == /\ ~eof /\ eof' = TRUE /\ closed' = GuardEOF
       /\ pending' = (IF GuardEOF THEN FALSE ELSE pending) /\ UNCHANGED response
Next == Response \/ EOF
SettledAtEOF == eof => closed /\ ~pending
PreserveResponse == response => ~pending
=============================================================================
