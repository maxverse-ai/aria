---------------- MODULE StaleUpdateLock ----------------
EXTENDS Naturals, FiniteSets
CONSTANT Actors
VARIABLES disk, seen, held
vars == <<disk, seen, held>>
Init == /\ disk = "stale" /\ seen = {} /\ held = {}
ReadStale(a) == /\ disk = "stale" /\ a \notin seen /\ seen' = seen \cup {a} /\ UNCHANGED <<disk,held>>
Unlink(a) == /\ a \in seen /\ disk' = "empty" /\ seen' = seen \ {a} /\ UNCHANGED held
Acquire(a) == /\ disk = "empty" /\ a \notin held /\ disk' = a /\ held' = held \cup {a} /\ UNCHANGED seen
Next == \E a \in Actors : ReadStale(a) \/ Unlink(a) \/ Acquire(a)
SingleUpdater == Cardinality(held) <= 1
=======================================================

