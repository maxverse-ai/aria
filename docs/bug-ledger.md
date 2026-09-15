# Aria bug ledger

> Status: current — append-only ledger; entries are never rewritten.

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
