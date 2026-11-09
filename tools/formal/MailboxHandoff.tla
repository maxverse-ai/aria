---------------------------- MODULE MailboxHandoff ----------------------------
EXTENDS Naturals
CONSTANT Transactional
VARIABLES mail, batch, delivered
vars == <<mail, batch, delivered>>
Init == /\ mail = "noticed" /\ batch = "none" /\ delivered = FALSE
Sweep == /\ mail = "noticed" /\ batch = "none"
         /\ batch' = "prepared"
         /\ mail' = IF Transactional THEN "claimed" ELSE "swept"
         /\ UNCHANGED delivered
Accept == /\ batch = "prepared" /\ batch' = "accepted"
          /\ delivered' = TRUE /\ mail' = "swept"
Reject == /\ batch = "prepared" /\ batch' = "rejected"
          /\ mail' = IF Transactional THEN "noticed" ELSE mail
          /\ UNCHANGED delivered
Next == Sweep \/ Accept \/ Reject
NoLostMail == delivered \/ mail \in {"noticed", "claimed"} \/ batch = "prepared"
=============================================================================
