# Runtime ownership repair evidence

> Status: historical — repairs the baseline findings in [the formal audit](FORMAL_AUDIT_IMPLEMENTATION.md); verify with `node tools/formal/check-architecture-audit.mjs` and the tests below.

## Changes

- ProcessPool reserves permits before resolving queued callers and releases each
  permit once. Queued callers have priority over newcomers after cap increases;
  lowering the cap does not interrupt existing holders.
- Mailbox pull and sweep share an exclusive filesystem claim protocol. The
  host releases claims on known start rejection, commits after successful local
  handoff, and retains uncertain submission outcomes. Dead pre-submission owners
  can be recovered without letting stale recovery modify newer generations.
  Stable IDs retain their original deposit. The protocol and operational limits
  are defined in [Steering](STEERING.md), not by the model alone.
- Codex engine-turn notifications follow the exact client connection; close and
  disposal unsubscribe the old listener. Reconnection attaches a new listener.
- All registered card actions and unknown-action fallback use the shared
  background queue. A macrotask boundary keeps synchronous handler I/O out of
  the callback's return path. Scope authorization still precedes command effects.

The old audit record is frozen. Its evidence tests now assert the corrected
behavior; TLC runner labels the old unsafe variants `legacy` and retains them
as negative controls. Reference variants remain abstractions, not proofs that
the TypeScript implementation refines the model.

## Model checks

The five legacy variants still produce expected counterexamples; five reference
variants and RuntimeRetirement pass. MailboxRecovery adds two competing owners,
preparation, submission, known rejection, acceptance, unknown response, owner
death and recovery, bounded to two claims. TLC v1.7.4 / 2.19 explores 82 distinct
states (145 generated) without violating NoBlindReplay, AtMostOneAcceptance,
NoSilentLoss or SingleOwner. This is safety checking; retained uncertainty does
not imply eventual delivery. The model assumes exclusive storage operations,
correct process-death detection and a trustworthy known-rejection signal.
It does not model filesystem failures, power loss, PID reuse or model effects.

## Real code verification

```text
pnpm exec vitest run tests/unit/runtime/formal-audit-evidence.test.ts tests/unit/runtime/process-pool.test.ts tests/unit/conversation/steer-mail-claims.test.ts tests/process/formal-audit-mailbox.test.ts tests/integration/bot/im-run-flow.test.ts tests/integration/card/callback-dispatch.test.ts
```

Tests exercise real pool microtask ordering, duplicate release and cap changes;
two independent mailbox consumers; subprocess exit before and after submission;
durable unknown outcomes; real run-flow policy rejection followed by accepted
retry; real Codex client/runtime reconnect over controlled stream transports;
and callback return before dispatcher scope I/O. They replace the corresponding
audit bug assertions with regression guards.

No test injects work into a live production conversation. Native Codex process
crash with a real goal continuation, the Feishu wire-level acknowledgement
deadline, and crashes between CLI output and engine consumption remain untested.
The mailbox commit is local execution handoff, not engine acceptance. An engine
failure after that handoff belongs to the run lifecycle; the mailbox does not
blindly replay its prompt. Unknown submissions require operator reconciliation.

The immutable claim journal is capped at 64 generations per message; terminal
claim tombstones intentionally prevent a late redeposit from becoming executable.
Unknown bodies and claims are retained for inspection rather than silently
expired. A large accumulated journal needs an explicit reconciled retention
policy, not deletion while a consumer might still own a generation.
