# Counterexamples and implementation evidence

For each counterexample, map its actions to source operations and identify a feasible execution ordering. Reject findings caused solely by an abstraction the implementation prevents. A model trace alone is a hypothesis about application behavior.

Prefer barriers, explicit scheduling and isolated temporary data over timing sleeps. Exercise real components; use independent processes for cross-process claims, and controlled transports for reconnect races. State which dependencies are replaced and which boundaries remain untested.

Turn a demonstrated failure into a desired-behavior regression after repair. Check that the failing ordering is actually exercised. Preserve correlation IDs, ownership generations and acceptance ambiguity in the implementation contract.

Run complete external scenarios only in isolated data or authorized environments. Do not inject work into production sessions to strengthen a report. Separate model success, component/process success and external scenario success. Local handoff is not remote acceptance, and neither proves exactly-once external side effects.

For extraction into a standalone skill repository, copy this entire skill directory. Keep target-specific commands and model mappings in the target project. Validate portability by applying the workflow to a second small protocol without importing the original project's paths or assumptions.
