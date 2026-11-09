---------------------------- MODULE UpdateLock ----------------------------
EXTENDS Naturals, FiniteSets
CONSTANT SafeJournal
VARIABLES latest, released, alive, held, observed, owners
vars == <<latest, released, alive, held, observed, owners>>
Actors == {1, 2}
Init == /\ latest = 0 /\ released = {0} /\ alive = Actors
        /\ held = {} /\ observed = [a \in Actors |-> 0]
        /\ owners = [g \in 0..3 |-> 0]
Observe(a) == /\ a \in alive /\ observed' = [observed EXCEPT ![a] = latest]
              /\ UNCHANGED <<latest, released, alive, held, owners>>
Acquire(a) == /\ a \in alive /\ a \notin held /\ latest < 3
              /\ latest \in released
              /\ (~SafeJournal \/ observed[a] = latest)
              /\ latest' = latest + 1 /\ held' = held \cup {a}
              /\ owners' = [owners EXCEPT ![latest + 1] = a]
              /\ UNCHANGED <<released, alive, observed>>
Release(a) == /\ a \in held /\ held' = held \ {a}
              /\ released' = released \cup {g \in 1..3 : owners[g] = a}
              /\ UNCHANGED <<latest, alive, observed, owners>>
Crash(a) == /\ a \in held /\ alive' = alive \ {a} /\ held' = held \ {a}
            /\ UNCHANGED <<latest, released, observed, owners>>
Recover(a) == /\ observed[a] > 0 /\ owners[observed[a]] \notin alive
              /\ released' = released \cup {observed[a]}
              /\ UNCHANGED <<latest, alive, held, observed, owners>>
StaleDelete(a) == /\ ~SafeJournal /\ a \in alive /\ observed[a] < latest
                  /\ released' = released \cup {latest}
                  /\ UNCHANGED <<latest, alive, held, observed, owners>>
Next == \E a \in Actors: Observe(a) \/ Acquire(a) \/ Release(a) \/ Crash(a) \/ StaleDelete(a) \/ Recover(a)
SingleUpdater == Cardinality(held) <= 1
=============================================================================
