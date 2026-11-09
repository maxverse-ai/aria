-------------------------- MODULE KeystoreTransaction --------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Serialized
Actors == {1, 2, 3}
Writers == {1, 2}
VARIABLES phase, owner, salt, localSalt, disk, snapshots, done, removed, keys
vars == <<phase, owner, salt, localSalt, disk, snapshots, done, removed, keys>>
Init == /\ phase = [a \in Actors |-> "idle"] /\ owner = 0 /\ salt = 0
        /\ localSalt = [a \in Actors |-> 0] /\ disk = {0}
        /\ snapshots = [a \in Actors |-> {}] /\ done = {} /\ removed = FALSE
        /\ keys = [a \in Writers |-> 0]
Start(a) == /\ phase[a] = "idle" /\ (~Serialized \/ owner = 0)
            /\ phase' = [phase EXCEPT ![a] = IF a \in Writers THEN "salt" ELSE "read"]
            /\ owner' = IF Serialized THEN a ELSE owner
            /\ UNCHANGED <<salt, localSalt, disk, snapshots, done, removed, keys>>
ReadSalt(a) == /\ phase[a] = "salt"
               /\ localSalt' = [localSalt EXCEPT ![a] = IF salt = 0 THEN a ELSE salt]
               /\ phase' = [phase EXCEPT ![a] = IF salt = 0 THEN "publish" ELSE "read"]
               /\ UNCHANGED <<owner, salt, disk, snapshots, done, removed, keys>>
Publish(a) == /\ phase[a] = "publish" /\ salt' = localSalt[a]
              /\ phase' = [phase EXCEPT ![a] = "read"]
              /\ UNCHANGED <<owner, localSalt, disk, snapshots, done, removed, keys>>
Read(a) == /\ phase[a] = "read" /\ snapshots' = [snapshots EXCEPT ![a] = disk]
           /\ phase' = [phase EXCEPT ![a] = "write"]
           /\ UNCHANGED <<owner, salt, localSalt, disk, done, removed, keys>>
Write(a) == /\ phase[a] = "write"
            /\ disk' = IF a \in Writers THEN snapshots[a] \cup {a} ELSE snapshots[a] \ {0}
            /\ done' = IF a \in Writers THEN done \cup {a} ELSE done
            /\ removed' = (removed \/ a = 3)
            /\ keys' = IF a \in Writers THEN [keys EXCEPT ![a] = localSalt[a]] ELSE keys
            /\ phase' = [phase EXCEPT ![a] = "done"]
            /\ owner' = IF Serialized THEN 0 ELSE owner
            /\ UNCHANGED <<salt, localSalt, snapshots>>
Next == \E a \in Actors: Start(a) \/ ReadSalt(a) \/ Publish(a) \/ Read(a) \/ Write(a)
NoLostCompletedWrite == done \subseteq disk
NoResurrectedRemoval == removed => 0 \notin disk
ConsistentSalt == \A a \in disk \cap Writers: keys[a] = salt
SingleTransaction == Serialized => Cardinality({a \in Actors: phase[a] \notin {"idle", "done"}}) <= 1
=============================================================================
