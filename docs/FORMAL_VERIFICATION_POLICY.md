# Formal verification policy

> Status: current

## Change assessment

Changes to concurrent ownership, queues, cancellation, timeout/retry, connection
generations, delivery or crash recovery require a protocol impact assessment.
Pure presentation, documentation and ordinary data transformations do not require
a new model unless they change one of those protocols. Unmapped paths are not
automatically exempt: assess the behavior and extend the inventory where needed.

Use the portable [TLA+ skill](../.agents/skills/tla-verification/SKILL.md) for the
method. This policy supplies the project contract; the skill contains no project
paths or commands. The repository-local `.agents/skills/` layout supports agent
hosts that discover project skills there. Other hosts can read `SKILL.md`
explicitly or install that whole directory using their supported mechanism.
No user-global installation is required. The whole `tla-verification` directory
can later move to an independent repository without taking this policy or the
project models with it.

## Inventory and obligations

[The model manifest](../tools/formal/manifest.json) is authoritative for group
IDs, source/test mappings, case configurations and the pinned toolchain. Use
`pnpm formal:check --list` to inspect it. Paths guide assessment; they do not
prove semantic impact or exhaustively identify callers.

| Protocol | Obligation and boundary |
| --- | --- |
| Codex resume | No submission after failed/stopped preparation, at most one submission per modeled run, exclusive scope ownership, bounded diagnostics and conditional settlement. Two runs and two connection generations; payload cost and native engine behavior are abstracted. |
| Pool handoff | Transfer a reserved permit to the waiter. Fixed-cap model; real regressions additionally cover cap changes and idempotent release. |
| Mailbox handoff/consumers | Known rejection preserves mail; competing consumers cannot both own a body. Storage claims are assumed exclusive. |
| Mailbox recovery | No blind replay, duplicate acceptance, silent loss or multiple owners. Two consumers and at most two claims; reliable death detection and known rejection are assumptions. |
| Engine subscription | A new connection owns its notification subscription. External engine continuation is abstracted. |
| Callback acknowledgement | Acknowledgement precedes handler I/O in the abstraction. Real SDK wire timing needs separate scenario evidence. |
| Runtime retirement | Disposal waits for borrowers, release is exclusive, and retirement drains under stated weak fairness. Two borrowers; non-releasing borrowers can block progress. |

Read the `.tla` and configuration for exact properties, finite bounds and
fairness. Terminal states explain disabled deadlock checks; this does not prove
application deadlock freedom. Passing reference variants do not prove TypeScript
refinement. Negative controls intentionally violate their named invariant.
Historical context: [audit](FORMAL_AUDIT_IMPLEMENTATION.md) and
[repair evidence](RUNTIME_OWNERSHIP_IMPLEMENTATION.md). Mailbox semantics remain
owned by [Steering](STEERING.md), not this document.

The subsequent [system audit](FORMAL_SYSTEM_AUDIT_IMPLEMENTATION.md) records
additional baseline findings and reproducible counterexamples; it is historical
evidence, not a claim that those findings have been repaired.
Use the [remediation handoff](FORMAL_REMEDIATION_HANDOFF.md) as the execution
prompt and durable progress ledger when undertaking that audit's remediation.

## Toolchain and execution

Download the official jar from the URL pinned in the manifest and set
`TLA2TOOLS_JAR` to its absolute path. Install a Java runtime meeting the manifest's
minimum and optionally set `JAVA` to its executable. The checker verifies the
jar SHA-256 and Java version; it neither downloads tools nor changes system
configuration. Local tool files may live in ignored `tools/formal/.toolchain/`.

```text
pnpm formal:check --list
pnpm formal:check pool
pnpm formal:check codex-resume mailbox-recovery
pnpm formal:check --report formal-results.json
```

No group selects all cases. `--verbose` prints complete TLC output; `--report`
writes per-case output, duration, expected result and status for evidence. Keep
generated reports outside tracked source. Tool failures, timeouts, incomplete
exploration and unexpected negative-control outcomes fail the command. Temporary
TLC state is isolated and removed. The two historical script entry points remain
compatible and use the same verified toolchain and case inventory.

Run affected groups and listed implementation regressions during development.
The required integration and publication gates are defined in `package.json`:
`ci:local` and `release:validate` include all formal checks, regardless of changed
paths. The lighter `check` command is not a complete integration gate. Missing
tools must be resolved before integration; there is no silent skip. Publication
reruns checks on its exact merged commit under [release policy](RELEASE_POLICY.md).

## Model and evidence maintenance

When behavior changes, update the relevant model/configuration, inventory and
implementation regressions together. If the abstraction remains valid, explain
why no model change is needed. Justify weakened properties, smaller bounds,
stronger fairness or added atomicity assumptions with implementation evidence.
Preserve specific expected failures for negative controls.

Record the checked revision, affected groups, commands, model bounds/assumptions,
outcomes and unverified boundaries. Separate finite model results from real-code
tests and isolated/external scenarios. Map counterexamples to feasible source
orderings before calling them application bugs. Use isolated data; tests do not
authorize production work. No live scenario or performance claim follows from
a model pass. Unknown submission is not known rejection, and local handoff is
not engine acceptance or exactly-once execution of external effects.
