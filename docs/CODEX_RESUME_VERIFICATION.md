# Codex resume verification

> Status: current — executable model in `tools/formal/CodexResume.tla` and regression tests named below.

The runtime contract is defined in [CODEX_APP_SERVER.md](CODEX_APP_SERVER.md).
This document connects the model to implementation boundaries and records what
the checks establish. It is not a performance claim about production Codex.

## Reproduction before the fix

At base `5eb27d5`, the controlled real-stdio tests reproduced:

- A held `thread/resume` rejected at the default 15-second client deadline while
  `account/read` completed and the shared process remained alive.
- Stop during a held resume did not prevent `turn/start` after its response.
  The simulated immediate completion could even produce a normal terminal event.
- Through `RunExecutor`, stop released scope/pool capacity. A replacement run
  completed, then releasing the old resume still submitted the old task.

The tests assert the desired behavior, so the two stop cases failed on the old
code. A third failed assertion identified missing light-resume parameters and
the dedicated deadline. These are synthetic protocol reproductions, not an
explanation of where a real Codex server spends time loading a long rollout.

## Running the model

Use Java and a local TLA+ tools jar (tested with release 1.7.4 / TLC 2.19).
Set `TLA2TOOLS_JAR` to its absolute path and optionally `JAVA` to the Java binary,
then run from the repository root:

```sh
node tools/formal/check-codex-resume.mjs
```

The runner requires the legacy configuration to violate `SafeSubmission`, then
requires both fixed configurations to pass. It runs locally, does not download
tools, and removes its temporary TLC state directory.

`CodexResumeLegacy.cfg` disables preparation cancellation/submission guarding.
Its five-state counterexample is: initialize, begin resume, stop, receive resume,
submit. The two fixed configurations use two one-shot runs, either sharing a
scope or using independent scopes, and at most two connection generations.
They enumerate deadline, stop, late response, submission, acceptance, completion,
scope release, connection close/reconnect and diagnostic expiration orderings.

The checked invariants are safe submission after stop/resource release, at most
one submission per run, scope exclusivity and bounded diagnostic cardinality.
Temporal checks require terminal states to remain terminal and begun runs to
eventually finish and release capacity. Weak fairness assumes enabled resume
deadlines, submission, cleanup and expiration eventually execute. Progress of
submitted turns through acceptance and completion is also a fairness assumption;
submission deadlines and indefinite model execution are not modeled. The model
does not assume resume responses eventually arrive.

TLC checked 1,804 distinct states for shared scope and 2,788 for independent
scopes without an invariant or temporal-property violation. Legacy produced the
expected safety violation. These results apply to this finite abstraction;
model checking is not a proof of the TypeScript implementation.

## Model-to-code mapping

| Model action | Implementation boundary | Regression evidence |
| --- | --- | --- |
| `Stop` during preparation | Per-run abort controller; submit-before-send guard | `codex-resume-safety.test.ts`: stop while held and executor replacement |
| `Deadline` | RPC timeout removes pending; run emits preparation failure | Resume timeout and explicit retry on the same thread |
| `Receive` after termination | Client matches pending, otherwise metadata-only diagnostic | Client late response is logged once, never resolves the rejected request |
| `Submit` | No async boundary between final abort check and request write | Stop during resume; existing runtime test stops at the yielded system event |
| `Release` | Existing executor cleanup after the native run settles | Capacity is reusable without a late old submission |
| `Close` / `Reconnect` | Pending rejection and runtime client replacement | Held run fails on process exit; next run resumes through a fresh client |
| `Expire` | Bounded map and unreferenced expiry timer | Client tests exceed capacity and advance time without new RPC traffic |

Run focused implementation checks with:

```sh
pnpm exec vitest run tests/unit/agent/codex-app-server-client.test.ts tests/process/codex-resume-safety.test.ts tests/process/codex-app-server.test.ts tests/process/codex-engine-turn.test.ts tests/process/codex-goal.test.ts
```

The model abstracts server acceptance/completion and does not prove a remote
operation can be canceled or that a stopped submitted turn has no side effects.
The submitting phase represents unknown acceptance. It does not model RPC byte
size, event-loop stalls, notification content, native import filesystem work,
or exact timer durations. The finite diagnostic bound in the model follows
from one request per run; implementation tests separately exercise eviction and
expiration. The model never automatically retries a submission or closes the
shared process because a single run times out.

## Protocol and performance limits

The local executable reporting `codex-cli 0.167.0-alpha.3.2` generated bindings
with `ThreadResumeParams.excludeTurns`; its generated documentation describes
omitting `thread.turns`. This validates field compatibility for that executable,
not the version or behavior of the original Linux production process.

No production session was resumed or given a test task. Real long-session
response sizes, cold/warm latency, server-internal bottlenecks and model context
continuity remain to be measured using an authorized isolated copy or valid
test session. Passing synthetic tests or TLC must not be presented as measured
production latency improvement. Windows gates also exclude the repository's
explicitly Linux-only execution-space/import suites.
