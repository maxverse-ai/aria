----------------------------- MODULE DaemonHost -----------------------------
EXTENDS Naturals, TLC
CONSTANT Legacy
VARIABLES child, failures, notified, incident, killedByHealth, starts
vars == <<child, failures, notified, incident, killedByHealth, starts>>
Init == /\ child = FALSE /\ failures = 0 /\ notified = FALSE
        /\ incident = FALSE /\ killedByHealth = FALSE /\ starts = 0
Start == /\ ~child /\ starts < 2 /\ child' = TRUE /\ starts' = starts + 1
         /\ UNCHANGED <<failures, notified, incident, killedByHealth>>
Crash == /\ child /\ child' = FALSE
         /\ UNCHANGED <<failures, notified, incident, killedByHealth, starts>>
Unhealthy == /\ failures < 2 /\ failures' = failures + 1 /\ incident' = TRUE
             /\ IF Legacy THEN /\ killedByHealth' = child /\ child' = FALSE
                           ELSE UNCHANGED <<child, killedByHealth>>
             /\ UNCHANGED <<notified, starts>>
SendFailure == /\ failures = 2 /\ ~notified /\ notified' = TRUE
               /\ UNCHANGED <<child, failures, incident, killedByHealth, starts>>
Healthy == /\ child /\ failures' = 0
           /\ IF notified THEN incident' = incident ELSE incident' = FALSE
           /\ UNCHANGED <<child, notified, killedByHealth, starts>>
SendRecovery == /\ child /\ failures = 0 /\ notified
                /\ notified' = FALSE /\ incident' = FALSE
                /\ UNCHANGED <<child, failures, killedByHealth, starts>>
Next == Start \/ Crash \/ Unhealthy \/ SendFailure \/ Healthy \/ SendRecovery
Spec == Init /\ [][Next]_vars
NoHealthKill == ~killedByHealth
AcknowledgedIncident == notified => incident
TypeOK == /\ child \in BOOLEAN /\ failures \in 0..2 /\ notified \in BOOLEAN
          /\ incident \in BOOLEAN /\ starts \in 0..2
=============================================================================
