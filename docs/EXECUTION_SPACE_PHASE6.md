# Execution space activation and migration

Status: core implemented and repository checks passed, based on Aria `0a299a4`. Work is owned by lease
`01M1XVVCAX6YK27ZS43GKHJ04W`. This document is not a deployment receipt.

The authorized increment completes explicit management activation, recoverable
migration and a ***REMOVED*** `codex-bot` functional acceptance. Personal remains default;
legacy team is unchanged until explicit preparation and activation. Team routing
and process isolation are separate decisions. ***REMOVED*** may explicitly select a
trusted shared-process deployment; that verifies application ownership, not OS
confinement. Bubblewrap and its tests retain their independent guarantees.

Implementation sequence:

1. Separate the admitted launch driver, preserving common environment and
   runtime ownership for execution and queries; no automatic fallback.
2. Add revision-bound preparation, management commit, activation/status and
   rollback. Ordinary preferences cannot activate or discard prepared spaces.
   Existing personal/legacy-team preference semantics remain compatible.
3. Inspect and copy staged ownership-bound state; keep unknown legacy state
   sealed, preserve native IDs where the actual engine proves resume, and
   retain immutable migration receipts and new data after rollback.
4. Integrate exact Aria source into ***REMOVED*** through its subtree/receipt workflow.
   Run compatibility first, then a temporary-state container rehearsal, then
   the scoped live deployment gate if all required behavior is supported.
5. Report exact artifacts, successful scenarios, sealed historical data,
   functional limitations and the independent isolation acceptance status.

Read-only preflight on 2026-09-07 found the running ***REMOVED*** image still on Aria
`f60e8b1`, Codex `0.153.4`, on a host offering no usable kernel sandbox. Its
catalog contained 72 thread references across 67 scopes, all
with rollouts present; the native sessions directory contained 395 JSONL files
(1,373,987,930 bytes). These are inventory observations, not ownership proof.
No real profile, credential, message or deployment has been changed so far.

## Management and ownership

`aria space prepare <deployment-file>` takes a private, explicit deployment
definition. `aria space inspect <selection-file>` returns a redacted migration
summary. `aria space activate <selection-file>` commits the exact preparation;
`aria space status` shows the active selection; `aria space rollback` restores
the previous personal/legacy-team mode. Select the profile with `--profile`.
Input files must be regular, private files (0600), without symlink ancestors.
Preparation output is a secret-free selection; save it with a private umask.

Prepare, activate and rollback acquire the existing profile runtime lock. The
profile must first drain and stop through its deployment's lifecycle owner.
Active legacy triggers and nonterminal occurrences must be drained or paused;
they are not retagged with a new user/space identity. No service kills a live
profile to obtain its lock. Configuration commits use ConfigChangeService's
revision, actor, confirmation, replay and authorization rules.

Personal remains the default. An existing `mode: team` with no selection keeps
legacy behavior. Prepared spaces require a verified immutable receipt selected
through the dedicated management service. A missing/changed receipt, native
binary version, resource ceiling or required environment variable fails closed.
Permission, engine, account, native-home and channel changes require a new
preparation. Admission and presentation preferences still reconcile normally.
Meetings remain unavailable until their resource audience adapter is implemented.

## Execution and channel contracts

The deployment declares its driver explicitly; an undeclared or unknown driver
is rejected rather than run unconfined. `trusted-process` selects a space-owned
native home, cwd, environment and runtime, and Codex/Grok execution and queries
share that runtime. Its children retain host filesystem/process/network access,
so passing the application tests does not establish an OS or credential
isolation boundary. Use the container driver when that boundary is required.

Native model credential values are resolved from explicitly named environment
keys at launch. They are not placed in selection files or public plans. Native
configuration templates are explicit host input, limited to known native config
targets; auth files, memory databases and shell state are not home templates.
Operator templates must not contain secrets.

Supervisor loads selected preparations itself. Embedded non-Lark compositions
use `openPreparedSpaceHost`, which owns the same profile lock, then pass its
space profile into the common conversation host and operation gates.
External channel plugins require `createSpaceIngress` with the identical
execution authority; legacy ingress is never used for a prepared profile.
Worker JSON cannot supply a trusted space context.

Prepared native environments do not inherit the profile-global lark-cli home,
binding or personal OAuth state. Channel API credentials remain host-owned.
The legacy lark-cli install/bind/import preflight is therefore not run for these
native environments. Native lark-cli access needs an explicit scoped credential
adapter before it can be accepted; compatibility mode retains existing behavior.

Native Read messages, session bindings and audits are written through the
authenticated source operation into its space. A global bearer token alone
provides health/metadata access in a prepared deployment; it cannot read private
history. A host controller must refresh an original source binding and return
an issued repository from that profile's SpaceNativeRead. Cross-space repositories
and cursors are rejected. Deployments that consumed the old global data API must
adapt before enabling prepared spaces; compatibility mode keeps the old API.

## Migration and rollback

Preparation owns a separate destination under
`profiles/<profile>/space-control/preparations/<id>/state`. It records config
revision, source index hashes, copied native source hashes, destination content
hashes, native verification and historical ownership evidence digests.
Replaying an unfinished preparation rebuilds only its disposable destination.
The old profile and native home are never moved, flattened or overwritten.

The public CLI's default preparation seals all legacy history. A deployment may
provide the shared `nativeSessionMigration` adapter with a trusted historical
ownership resolver. The resolver must return an issued authorization matching
the old scope and native ID, plus retained historical evidence. Present-day
group membership alone does not prove ownership of past private history.
Unknown entries, archived entries and native IDs referenced by multiple old
catalog entries remain sealed. Activating any sealed history requires the explicit
`--accept-sealed-history` option after reviewing the preparation summary.

Native migration is an optional engine plugin capability, independent from
ordinary resume support. Codex's implementation copies only approved rollouts,
checks hashes/IDs, resumes through the native API, repairs/lists the native index,
and proves restart/resume/read behavior. It preserves thread IDs. Native recorded
cwd and future execution cwd are distinct: a bounded native query alias retains
old history without editing SQLite or message content. The Aria catalog is
rebuilt using the same policy projection as live execution. Imported per-scope
idle timeout preferences are preserved.

Other engines keep their explicit launch/query adapters and fixture coverage.
Without a verified native importer their old sessions remain sealed. Native
memories, goals, queues, auth stores, shell snapshots, workspace files, attachments
and historical Native Read message projections are not bulk-copied into new
user spaces. They require separate ownership evidence and format adapters.

Rollback restores the prior selection/mode through the mutation kernel while
retaining newly written prepared state. It does not merge new space data into the
legacy home. A later migration must reconcile that retained state explicitly.
Deployment rollback must restore a compatible mode/config before starting an old
Aria build that does not understand execution-space selections.

## Acceptance evidence and remaining deployment work

Focused tests cover explicit activation, unknown-history acknowledgement,
replay, interrupted preparation, source/destination/config drift, profile locks,
operator rejection, native-read authority and cursor fencing, and original-ID
resume after ownership migration. Seven native process fixtures cover the
trusted driver. The real Codex 0.153.4 acceptance separately demonstrated
rollout import, original-ID resume after process restart, old content reading
and owned history queries; it uses synthetic history and no real credentials.

The full local gate passed 1,561 tests (one real-native test is opt-in and passed
separately), build, release checks and both TypeScript checks. Exact-head
repository validation and subtree/receipt integration into the embedding
deployment remain deployment prerequisites. That deployment requires a
compatibility upgrade, temporary-state rehearsal, exact image/source receipts,
resident-service health checks and a tested rollback. Real Feishu messages need
designated test subjects; a fixture or direct model request is not a live
provider-authentication acceptance.
