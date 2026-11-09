---
name: tla-verification
description: Model and verify concurrent protocols with TLA+ and TLC, analyze counterexamples, and connect model results to implementation regressions. Use for protocol design or changes involving ownership, retries, delivery, or recovery.
---

# TLA+ protocol verification

Read the target project's formal verification contract first. Use its model inventory, commands and acceptance boundaries. If absent, establish the relevant contract using [the project template](templates/project-contract.md); do not invent project policy or expand authorization.

1. Identify changed actors, states, ownership transfers and acceptance boundaries. Reuse an existing model when its abstraction fits; explain when a change does not affect modeled behavior.
2. For modeling or changes to assumptions, read [modeling guidance](references/modeling.md). State safety properties separately from progress properties and their fairness assumptions.
3. Run the project's checker with its pinned toolchain. Tool absence, parse errors, timeout and incomplete exploration are failures to verify, never successful checks.
4. For a counterexample or repair, read [implementation validation](references/implementation-validation.md). Trace each relevant transition to real code and build a deterministic regression where feasible.
5. Report the checked revision, configurations, bounds, assumptions, commands and outcomes using [the evidence template](templates/verification-report.md). Distinguish model exploration, implementation tests and real scenarios.

A finite passing model does not establish implementation refinement or unrestricted correctness. Explain reductions in properties, bounds or coverage; do not adjust assumptions solely to obtain a pass. Preserve useful negative controls and require their specific expected failure, not merely a nonzero exit.

This directory is portable. Resolve these resources relative to this file; obtain repository paths and commands from the target project's contract. It requires no particular agent host, repository layout or automatic discovery mechanism.

