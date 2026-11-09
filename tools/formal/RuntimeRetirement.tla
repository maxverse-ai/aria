--------------------------- MODULE RuntimeRetirement ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Borrowers
VARIABLES held, released, closing, disposed
vars == <<held, released, closing, disposed>>
Init == /\ held = {} /\ released = {} /\ closing = FALSE /\ disposed = FALSE
Acquire(b) == /\ ~closing /\ b \notin held \cup released
              /\ held' = held \cup {b} /\ UNCHANGED <<released, closing, disposed>>
Release(b) == /\ b \in held /\ held' = held \ {b}
              /\ released' = released \cup {b} /\ UNCHANGED <<closing, disposed>>
Retire == /\ ~closing /\ closing' = TRUE /\ UNCHANGED <<held, released, disposed>>
Dispose == /\ closing /\ held = {} /\ ~disposed /\ disposed' = TRUE
           /\ UNCHANGED <<held, released, closing>>
Next == (\E b \in Borrowers : Acquire(b) \/ Release(b)) \/ Retire \/ Dispose
Spec == Init /\ [][Next]_vars /\ (\A b \in Borrowers : WF_vars(Release(b))) /\ WF_vars(Dispose)
SafeRetirement == disposed => closing /\ held = {}
NoDoubleRelease == held \cap released = {}
Drains == closing ~> disposed
=============================================================================
