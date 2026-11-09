------------------------- MODULE ManagedCardFallback -------------------------
EXTENDS Naturals
CONSTANT Guard
VARIABLES phase, accepted, rejected, attempt
vars == <<phase, accepted, rejected, attempt>>
Init == /\ phase = "reference" /\ accepted = 0 /\ rejected = FALSE /\ attempt = 1
Accept == /\ phase = "reference" /\ accepted' = 1 /\ phase' = "done"
          /\ UNCHANGED <<rejected, attempt>>
Reject == /\ phase = "reference" /\ rejected' = TRUE /\ phase' = "failed"
          /\ UNCHANGED <<accepted, attempt>>
Unknown == /\ phase = "reference" /\ accepted' = 1 /\ phase' = "unknown"
           /\ UNCHANGED <<rejected, attempt>>
StopUnknown == /\ phase = "unknown" /\ phase' = "failed"
               /\ UNCHANGED <<accepted, rejected, attempt>>
RetryReject == /\ phase = "unknown" /\ phase' = "failed" /\ rejected' = TRUE
               /\ attempt' = 2 /\ UNCHANGED accepted
Fallback == /\ phase = "failed"
            /\ (~Guard \/ (rejected /\ attempt = 1))
            /\ accepted' = accepted + 1 /\ phase' = "done"
            /\ UNCHANGED <<rejected, attempt>>
Next == Accept \/ Reject \/ Unknown \/ StopUnknown \/ RetryReject \/ Fallback
NoDuplicateAcceptance == accepted <= 1
=============================================================================
