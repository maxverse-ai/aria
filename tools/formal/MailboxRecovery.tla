---------------------------- MODULE MailboxRecovery ----------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Consumers
VARIABLES state, owner, alive, attempts, accepted, mayHaveSubmitted
vars == <<state, owner, alive, attempts, accepted, mayHaveSubmitted>>
Init == /\ state = "unread" /\ owner = "none" /\ alive = Consumers
        /\ attempts = 0 /\ accepted = 0 /\ mayHaveSubmitted = FALSE
Claim(c) == /\ state = "unread" /\ c \in alive /\ attempts < 2
            /\ state' = "prepared" /\ owner' = c /\ attempts' = attempts + 1
            /\ UNCHANGED <<alive, accepted, mayHaveSubmitted>>
Submit == /\ state = "prepared" /\ owner \in alive /\ state' = "submitting"
          /\ mayHaveSubmitted' = TRUE /\ UNCHANGED <<owner, alive, attempts, accepted>>
Reject == /\ state \in {"prepared", "submitting"} /\ owner \in alive
          /\ state' = "unread" /\ owner' = "none" /\ mayHaveSubmitted' = FALSE
          /\ UNCHANGED <<alive, attempts, accepted>>
Accept == /\ state = "submitting" /\ owner \in alive /\ state' = "committed"
          /\ accepted' = accepted + 1 /\ UNCHANGED <<owner, alive, attempts, mayHaveSubmitted>>
Unknown == /\ state = "submitting" /\ owner \in alive /\ state' = "uncertain"
           /\ UNCHANGED <<owner, alive, attempts, accepted, mayHaveSubmitted>>
Crash(c) == /\ c \in alive /\ alive' = alive \ {c}
            /\ UNCHANGED <<state, owner, attempts, accepted, mayHaveSubmitted>>
Recover == /\ state \in {"prepared", "submitting"} /\ owner \notin alive
           /\ state' = IF state = "prepared" THEN "unread" ELSE "uncertain"
           /\ owner' = "none" /\ UNCHANGED <<alive, attempts, accepted, mayHaveSubmitted>>
Next == (\E c \in Consumers : Claim(c) \/ Crash(c)) \/ Submit \/ Reject \/ Accept \/ Unknown \/ Recover
NoBlindReplay == mayHaveSubmitted => state # "unread"
AtMostOneAcceptance == accepted <= 1
NoSilentLoss == accepted > 0 \/ state \in {"unread", "prepared", "submitting", "uncertain"}
SingleOwner == state \in {"prepared", "submitting"} => owner \in Consumers
=============================================================================
