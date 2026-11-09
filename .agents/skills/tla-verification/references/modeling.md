# Modeling decisions

Define the observable contract before choosing variables: who owns a resource, what counts as acceptance, and which outcomes are known versus uncertain. Separate stopping a local wait from cancelling a remote effect.

Model competing actors and transitions at the actual atomicity boundary. An atomic rename does not make an entire read/check/write protocol atomic. Include stale owners or connection generations when they can act after recovery.

Choose the smallest finite bounds that expose meaningful contention, then explain their limits. Two actors often expose ownership races but do not establish arbitrary population correctness. Include cancellation, duplicate events, known rejection, unknown outcomes and crash/recovery where the changed protocol permits them.

State invariants and temporal properties separately. Liveness needs explicit environment and fairness assumptions; a retained uncertain outcome can preserve safety while preventing progress. Explain disabled deadlock checking when terminal states intentionally have no successors. Review state constraints for excluded failure paths and vacuous properties.

Keep buggy variants as negative controls where useful. A repair should preserve the same safety obligation. Record every removed property, reduced bound, new atomic operation or stronger fairness assumption and why the implementation supports it.
