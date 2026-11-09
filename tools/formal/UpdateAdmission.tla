------------------------- MODULE UpdateAdmission -------------------------
EXTENDS Naturals, FiniteSets
CONSTANT SafeFence
VARIABLES stage, marker, fenced, acknowledged, active, running, updaterAlive,
          processIdentity, accepted, safeStops
vars == <<stage, marker, fenced, acknowledged, active, running, updaterAlive,
          processIdentity, accepted, safeStops>>
Profiles == {1, 2}
Init == /\ stage = 0 /\ marker = {} /\ fenced = {} /\ acknowledged = {}
        /\ active = {} /\ running = Profiles /\ updaterAlive = TRUE
        /\ processIdentity = 0 /\ accepted = FALSE /\ safeStops = TRUE
Publish(p) == /\ stage = 0 /\ updaterAlive /\ p \notin marker
              /\ marker' = marker \cup {p}
              /\ UNCHANGED <<stage, fenced, acknowledged, active, running, updaterAlive, processIdentity, accepted, safeStops>>
Begin == /\ stage = 0 /\ marker = Profiles /\ stage' = 1
         /\ UNCHANGED <<marker, fenced, acknowledged, active, running, updaterAlive, processIdentity, accepted, safeStops>>
Fence(p) == /\ stage = 1 /\ updaterAlive /\ p \in marker
            /\ fenced' = fenced \cup {p}
            /\ UNCHANGED <<stage, marker, acknowledged, active, running, updaterAlive, processIdentity, accepted, safeStops>>
Admit(p) == /\ p \in running /\ p \notin active
            /\ (~SafeFence \/ p \notin fenced \/ ~updaterAlive)
            /\ active' = active \cup {p}
            /\ UNCHANGED <<stage, marker, fenced, acknowledged, running, updaterAlive, processIdentity, accepted, safeStops>>
Finish(p) == /\ p \in active /\ active' = active \ {p}
             /\ UNCHANGED <<stage, marker, fenced, acknowledged, running, updaterAlive, processIdentity, accepted, safeStops>>
Drain(p) == /\ stage = 1 /\ updaterAlive /\ p \in fenced /\ p \notin active
            /\ acknowledged' = acknowledged \cup {p}
            /\ UNCHANGED <<stage, marker, fenced, active, running, updaterAlive, processIdentity, accepted, safeStops>>
Stop == /\ stage = 1 /\ acknowledged = Profiles /\ updaterAlive
        /\ safeStops' = (safeStops /\ active = {})
        /\ running' = {} /\ active' = {} /\ stage' = 2
        /\ UNCHANGED <<marker, fenced, acknowledged, updaterAlive, processIdentity, accepted>>
Start(i) == /\ stage = 2 /\ updaterAlive
            /\ running' = Profiles /\ stage' = 3 /\ processIdentity' = i
            /\ UNCHANGED <<marker, fenced, acknowledged, active, updaterAlive, accepted, safeStops>>
Health == /\ stage = 3 /\ updaterAlive
          /\ (~SafeFence \/ processIdentity = 1)
          /\ accepted' = TRUE /\ stage' = 4
          /\ UNCHANGED <<marker, fenced, acknowledged, active, running, updaterAlive, processIdentity, safeStops>>
Release == /\ stage = 4 /\ updaterAlive /\ marker' = {} /\ fenced' = {} /\ stage' = 5
           /\ UNCHANGED <<acknowledged, active, running, updaterAlive, processIdentity, accepted, safeStops>>
Crash == /\ updaterAlive /\ updaterAlive' = FALSE
         /\ UNCHANGED <<stage, marker, fenced, acknowledged, active, running, processIdentity, accepted, safeStops>>
Next == Begin \/ (\E p \in Profiles: Publish(p) \/ Fence(p) \/ Admit(p) \/ Finish(p) \/ Drain(p))
        \/ Stop \/ (\E i \in {0,1}: Start(i)) \/ Health \/ Release \/ Crash
Spec == Init /\ [][Next]_vars
SafeStop == safeStops
ExpectedBuild == accepted => processIdentity = 1
=============================================================================
