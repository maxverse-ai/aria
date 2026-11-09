---------------------------- MODULE CodexResume ----------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Runs, SameScope, GuardStop
VARIABLES phase, stopped, held, submitted, pending, inflight, diagnostic,
          epoch, connection, connected, badSubmit

vars == <<phase, stopped, held, submitted, pending, inflight, diagnostic,
          epoch, connection, connected, badSubmit>>
Scope(r) == IF SameScope THEN "shared" ELSE r
Token(r) == <<r, epoch[r]>>

Init == /\ phase = [r \in Runs |-> "idle"]
        /\ stopped = {}
        /\ held = {}
        /\ submitted = [r \in Runs |-> 0]
        /\ pending = {} /\ inflight = {} /\ diagnostic = {}
        /\ epoch = [r \in Runs |-> 0]
        /\ connection = 1 /\ connected = TRUE /\ badSubmit = FALSE

Begin(r) == /\ connected /\ phase[r] = "idle"
            /\ ~\E s \in held : Scope(s) = Scope(r)
            /\ phase' = [phase EXCEPT ![r] = "waiting"]
            /\ held' = held \cup {r}
            /\ epoch' = [epoch EXCEPT ![r] = connection]
            /\ pending' = pending \cup {<<r, connection>>}
            /\ inflight' = inflight \cup {<<r, connection>>}
            /\ UNCHANGED <<stopped, submitted, diagnostic, connection, connected, badSubmit>>

Stop(r) == /\ phase[r] \in {"waiting", "ready", "submitting", "running"}
           /\ r \notin stopped
           /\ stopped' = stopped \cup {r}
           /\ IF GuardStop /\ phase[r] \in {"waiting", "ready"}
                 THEN /\ phase' = [phase EXCEPT ![r] = "terminal"]
                      /\ pending' = pending \ {Token(r)}
                      /\ diagnostic' = diagnostic \cup (pending \cap {Token(r)})
                 ELSE UNCHANGED <<phase, pending, diagnostic>>
           /\ UNCHANGED <<held, submitted, inflight, epoch, connection, connected, badSubmit>>

Deadline(r) == /\ phase[r] = "waiting"
               /\ phase' = [phase EXCEPT ![r] = "terminal"]
               /\ pending' = pending \ {Token(r)}
               /\ diagnostic' = diagnostic \cup {Token(r)}
               /\ UNCHANGED <<stopped, held, submitted, inflight, epoch, connection, connected, badSubmit>>

Receive(t) == /\ t \in inflight
              /\ inflight' = inflight \ {t}
              /\ pending' = pending \ {t}
              /\ diagnostic' = diagnostic \ {t}
              /\ phase' = IF t \in pending /\ t[2] = connection /\ connected
                              /\ phase[t[1]] = "waiting"
                            THEN [phase EXCEPT ![t[1]] = "ready"] ELSE phase
              /\ UNCHANGED <<stopped, held, submitted, epoch, connection, connected, badSubmit>>

Submit(r) == /\ phase[r] = "ready" /\ connected
             /\ (~GuardStop \/ r \notin stopped)
             /\ phase' = [phase EXCEPT ![r] = "submitting"]
             /\ submitted' = [submitted EXCEPT ![r] = @ + 1]
             /\ badSubmit' = (badSubmit \/ r \in stopped \/ r \notin held)
             /\ UNCHANGED <<stopped, held, pending, inflight, diagnostic, epoch, connection, connected>>

Accepted(r) == /\ phase[r] = "submitting"
               /\ phase' = [phase EXCEPT ![r] = "running"]
               /\ UNCHANGED <<stopped, held, submitted, pending, inflight, diagnostic, epoch, connection, connected, badSubmit>>

Finish(r) == /\ phase[r] = "running"
             /\ phase' = [phase EXCEPT ![r] = "terminal"]
             /\ UNCHANGED <<stopped, held, submitted, pending, inflight, diagnostic, epoch, connection, connected, badSubmit>>

Release(r) == /\ r \in held
              /\ (phase[r] = "terminal" \/ r \in stopped)
              /\ held' = held \ {r}
              /\ UNCHANGED <<phase, stopped, submitted, pending, inflight, diagnostic, epoch, connection, connected, badSubmit>>

Close == /\ connected /\ connected' = FALSE
         /\ phase' = [r \in Runs |-> IF phase[r] \in {"waiting", "ready", "submitting", "running"}
                                      THEN "terminal" ELSE phase[r]]
         /\ pending' = {} /\ diagnostic' = {}
         /\ UNCHANGED <<stopped, held, submitted, inflight, epoch, connection, badSubmit>>
Reconnect == /\ ~connected /\ connection = 1
             /\ connection' = 2 /\ connected' = TRUE
             /\ UNCHANGED <<phase, stopped, held, submitted, pending, inflight, diagnostic, epoch, badSubmit>>
Expire == /\ diagnostic # {} /\ diagnostic' = {}
          /\ UNCHANGED <<phase, stopped, held, submitted, pending, inflight, epoch, connection, connected, badSubmit>>

Next == (\E r \in Runs : Begin(r) \/ Stop(r) \/ Deadline(r) \/ Submit(r)
                        \/ Accepted(r) \/ Finish(r) \/ Release(r))
        \/ (\E t \in inflight : Receive(t)) \/ Close \/ Reconnect \/ Expire
Spec == Init /\ [][Next]_vars
        /\ (\A r \in Runs : WF_vars(Deadline(r)) /\ WF_vars(Submit(r))
                            /\ WF_vars(Accepted(r)) /\ WF_vars(Finish(r)) /\ WF_vars(Release(r)))
        /\ WF_vars(Expire)

SafeSubmission == ~badSubmit
AtMostOnce == \A r \in Runs : submitted[r] \in 0..1
ScopeExclusive == \A r,s \in held : Scope(r) = Scope(s) => r = s
BoundedDiagnostics == Cardinality(diagnostic) <= Cardinality(Runs)
TerminalStable == \A r \in Runs : [](phase[r] = "terminal" => [] (phase[r] = "terminal"))
EventuallySettled == \A r \in Runs : (phase[r] # "idle") ~> (phase[r] = "terminal" /\ r \notin held)
=============================================================================
