------------------------- MODULE EngineEventIdentity -------------------------
CONSTANT Guard
VARIABLES ended, wrongTerminal, presentedReplay
vars == <<ended, wrongTerminal, presentedReplay>>
Init == /\ ended = FALSE /\ wrongTerminal = FALSE /\ presentedReplay = FALSE
OldCompletion == /\ ~ended /\ ~Guard /\ ended' = TRUE /\ wrongTerminal' = TRUE
                 /\ UNCHANGED presentedReplay
CurrentCompletion == /\ ~ended /\ ended' = TRUE /\ UNCHANGED <<wrongTerminal, presentedReplay>>
LoadReplay == /\ ~ended /\ ~Guard /\ ~presentedReplay /\ presentedReplay' = TRUE
              /\ UNCHANGED <<ended, wrongTerminal>>
Next == OldCompletion \/ CurrentCompletion \/ LoadReplay
CurrentEventsOnly == ~wrongTerminal /\ ~presentedReplay
CurrentTurnOnly == ~wrongTerminal
NoReplayOutput == ~presentedReplay
=============================================================================
