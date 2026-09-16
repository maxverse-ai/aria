# Aria bug ledger

> Status: current — append-only ledger; entries are never rewritten.

## ARIA-PI-001 — A multi-line prompt cannot reach the `pi` engine on Windows

- Evidence: `tests/process/engine-construction.test.ts` cannot exercise `pi`
  through its Windows fixture. `buildPiArgs` appends the whole prompt — which
  includes the multi-line bridge system prompt — as the last argv element.
- Cause: on Windows an npm-installed CLI is a `.cmd` shim, `cross-spawn` reaches
  it through `cmd.exe /d /s /c`, and its argument escaping covers cmd
  metacharacters but has no handling for newlines, which terminate a cmd
  command. The prompt is truncated at its first newline. This is not only a
  fixture artifact: spawning the real `pi` takes the same path.
- Fix: not attempted. `pi` may accept its prompt on stdin the way `claude -p`
  does, but `pi` is not installed on the machine this was written from, so its
  CLI contract could not be verified. Changing the transport blind would risk
  breaking the engine where it currently works.
- Validation: the mechanism is confirmed from the argv builder and cross-spawn's
  Windows escaping; the engine itself was not run.
- Scope: Windows only. `pi` is unaffected on Linux and macOS.
- Status: open. Verify `pi`'s stdin contract, move the prompt off argv, then
  restore the Windows launch cases.

## ARIA-PROBE-001 — Engine version probe intermittently reported installed without a version

- Evidence: on 2026-09-15, two CI runs failed `plugin-probe` on different
  platforms with different engines — Ubuntu/`opencode` and macOS/`kimi` — each
  reading `{ installed: true, version: undefined }` while the same fake binary
  passed on every other attempt. The failing test file took 215ms, so the 30s
  probe timeout never fired, and 50 consecutive local runs did not reproduce it.
- Cause: not established. `readVersion` collapsed three distinct outcomes —
  timeout, non-zero exit, silent output — into the same `undefined`, which made
  the report undiagnosable. The child failed fast on a binary that works.
- Fix: partial. The probe now records which outcome occurred in
  `EngineProbeStatus.error` while leaving `installed` true, and retries once for
  any failure other than a timeout. The retry is a mitigation: a binary that
  genuinely cannot report a version fails both attempts, so nothing persistent
  is hidden.
- Validation: a fake engine that exits non-zero records `exited with code …`
  plus its stderr, a silent one records `produced no output`, and a fake that
  fails only on its first run is reported with its version and no error.
- Scope: engine availability reporting only; it does not change which engines
  can run.
- Status: open. The retry has not yet been observed under the conditions that
  produced the original failure. If `plugin-probe` fails again, `error` now names
  the outcome, which is the evidence needed to close this.

## ARIA-TOOLS-003 — Historical socket arguments broke current native tool calls

- Evidence: on 2026-09-09, a retained ***REMOVED*** Codex conversation repeatedly used
  an obsolete socket with a current run ticket, returning ECONNREFUSED while
  the current endpoint successfully handled calls in the same conversation.
- Cause: endpoint routing was copied from conversational history independently
  of the per-run authority. Owner: SpaceNativeTools.
- Fix: atomically publish the current socket inside the existing generated
  invoke.mjs client. New prompts use --current; legacy socket arguments are
  accepted but never used as destinations or fallback endpoints. No ticket is
  persisted in the client or renewed on behalf of old tasks.
- Validation: real child-process calls with an obsolete listening trap socket,
  concurrent actors, foreign working directories, ended tickets, owner
  recreation with the same client path, and unavailable current service.
- Scope: routing reliability under the existing trusted-process boundary; this
  does not add OS-user isolation or remove task tickets from model inputs.
- Status: source regression checks and repository gate required before exact
  downstream integration; deployment acceptance is recorded by ***REMOVED***.

## ARIA-READ-001 — Management sessions vanished after prepared Space activation

- Cause: an ambient profile reader cannot represent private Space stores.
  Turning ordinary transport credentials into cross-Space authority would
  weaken execution isolation; browser personal grants are not an admin UI.
- Fix: explicit signed host-management reads, source-partitioned derived index,
  read-only legacy bootstrap and incremental committed-change mirroring;
  bounded session-summary snapshots, real activity ordering and channel names.
- Safety: signing key stays outside agent runtimes, ordinary Space API fences
  remain, index/audit failures only deny management reads. Legacy history and
  ownership stay untouched; no running process is migrated or interrupted.
- Validation: signature/replay, two-Space plus legacy, stable cursor, name cache,
  stale metadata, checkpoint recovery and broken-index/intake regressions.
- Remaining deployment acceptance: exact upstream integration, downstream pin,
  separate signing-key authorization and an idle-only rollout. Old opaque
  records without names still require authoritative source metadata to backfill.

## ARIA-TEAM-002 — Stored detailed CoT did not take effect in prepared Team

- Evidence: ***REMOVED*** Codex Bot retained `cotMessages=detailed`, while prepared
  Space composition forced final-only delivery and disabled the raw CoT path.
  Configuration/status reported the stored preference without runtime capability.
- Root cause: the existing CoT client bypassed Space authorization; simply
  enabling it would allow private updates after an audience change. The old
  policy ABI had no checked-progress capability.
- Fix: profile-owned presentation resolution, an additive checked-payload
  policy port, per-operation CoT/card ownership, finite terminal cleanup and
  authenticated runtime presentation reporting. See `team-presentation.md`.
- Validation: deterministic lifecycle, policy, card batching, restart, public
  control snapshot and Lark intake regressions; deployment integration and real
  platform acceptance are recorded separately in the downstream receipt.
- Compatibility: no configuration or session migration, no admission-policy
  change, no automatic private-to-shared task transfer.

## ARIA-TEAM-001 — Team activation rejected with exec credential references

- Found in installed Aria `56b937abb3b5621dd011b81862b777a58b9f4510`
  during the ***REMOVED*** Codex Bot activation on 2026-09-08 08:52 北京时间.
- Evidence: managed job `d7fdd3005d07a6c397a1cd9498724d32` failed before
  configuration commit and restored legacy Team. All 72 original catalog
  entries were retained. The synthetic legacy-Team/exec-reference regression
  reproduced `plan parameters or summaries contain sensitive data`.
- Root cause: the configuration plan guard collected secret descriptor `source`
  enum values as secret content; `exec` matched `executionSpaces`, and `file`
  could match `profile` in an otherwise public plan.
- Impact and classification: P0. The supported managed Team activation cannot
  complete for the resident exec-reference credential configuration. Remaining
  on legacy Team preserves availability but does not provide the requested
  isolation; bypassing the configuration owner is not a supported workaround.
- Owner: Aria configuration mutation kernel. Exclude only the recognized,
  top-level secret descriptor discriminator from sensitive-value collection.
  Continue protecting plaintext values, handles, provider commands, arguments,
  environment values, paths and defaults, including literal `exec` contents.
- Verification: targeted management activation/rollback and guard regressions;
  the authoritative repository gate and exact-source ***REMOVED*** deployment are
  required before resident activation is retried. Real Feishu user acceptance
  remains separate from this deterministic regression.
- Status: fixed in source; awaiting integration and installed verification.


## ARIA-HISTORY-001 — Historical sender admission invalidates the active reply

- Found: ***REMOVED***'s Aria b7962cc, 2026-09-09 22:44–23:03 北京时间; reproduced on
  Aria 103f248 using the real gate and binding store. Three completed runs in
  a solo group failed delivery with `result audience changed`; subsequent
  requests received new execution scopes and fresh model sessions.
- Cause: reply freshness admitted historical senders through `gate.enter`,
  which mutates the conversation binding. Bot history in a user-owned Space
  selected a different route, while rejected history could suspend the owner.
  The recovery notice also retained its obsolete outbound scope.
- Impact: P0, supported solo-group replies cannot reliably complete; repeating
  the request or restarting does not remove the trigger. No acceptable workaround.
- Owner: Aria Space authorization and Lark final-reply history adapter.
- Fix: authorize historical senders only within the original live binding;
  do not bind, suspend, renew or invalidate that binding. Keep independent
  sender admission/access ceilings and original-authority refresh before
  publication. Bind recovery-notice policy and projection to the new operation.
- Verification: real-store consecutive-turn reproduction failed before the
  change; regression and Lark intake/final delivery tests cover bot history,
  denied/departed senders, incomplete evidence, peer permission ceilings and
  actual member changes. Full repository gate and ***REMOVED*** rollout remain required.
- Status: fixed in candidate; deployment receipts determine production status.
## ARIA-CODEX-EOF-001: Skill discovery invalidates its own execution container

- Found on Aria f6fef1a in ***REMOVED***, 2026-09-13 18:34-19:26 Beijing time.
- Impact: P0. Direct messages arrive but fail before a Codex turn starts;
  restarting does not remove the supported workspace-skill trigger.
- Cause: native skill discovery disposes a stdio client with SIGTERM. The
  Podman adapter correctly fences signalled transports, closing the whole
  environment. The registry then repeatedly rebuilds the unusable startup.
- Evidence: deterministic Podman/client regression invalidates the environment
  after successful discovery; registry regression exceeds two constructions.
  Production also recorded OS error 11, Podman EAGAIN, and aggregate PID-limit
  events. Those historical counters do not identify every exhausted process.
- Owner: Aria Codex stdio lifecycle and Space runtime registry.
- Fix: close stdin and await normal exit before bounded TERM/KILL escalation;
  allow one startup replacement, then retire, release capacity and back off.
- Verification: client/Podman contract, real subprocess EOF shutdown, and
  repeated-poisoned-startup recovery regressions. Full gate and ***REMOVED*** deployment
  receipts determine installed status.
- Workaround: none verified for the ordinary workspace-enabled message path.
- Status: fixed in candidate; awaiting validation and deployment.
