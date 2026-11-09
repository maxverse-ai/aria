---------------- MODULE KeystoreWrites ----------------
EXTENDS FiniteSets
CONSTANT Actors
VARIABLES disk, snapshots, read, done
vars == <<disk,snapshots,read,done>>
Init == /\ disk = {} /\ snapshots = [a \in Actors |-> {}] /\ read = {} /\ done = {}
Read(a) == /\ a \notin read /\ read' = read \cup {a} /\ snapshots' = [snapshots EXCEPT ![a] = disk] /\ UNCHANGED <<disk,done>>
Write(a) == /\ a \in read /\ a \notin done /\ disk' = snapshots[a] \cup {a} /\ done' = done \cup {a} /\ UNCHANGED <<read,snapshots>>
Next == \E a \in Actors : Read(a) \/ Write(a)
NoLostCompletedWrite == done \subseteq disk
=======================================================
