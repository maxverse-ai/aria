# Business workspace provisioning

Business projects own navigation, rules and skills. The deployment selects a
bundle for an exact SpaceKey and admits its resources. Aria owns validated
installation, reconciliation, per-run navigation and native discovery. Aria's
core and tests contain no project paths, business rules or default assignments.

## Configuration and lifecycle

`<profileDir>/space-control/workspaces.v1.json` is a private (0600), host-owned
`aria.space.workspaces.v1` definition. It is independent of the sealed execution
preparation and its fingerprint. `normalizeSpaceWorkspaces` is the public
validation boundary; `WorkspaceBundle` and `SpaceWorkspacesDefinition` are the
public deployment types. Files are UTF-8 assets with explicit SHA-256 digests.

Each bundle has `id`, `revision`, `entry`, `files`, `skills`, and `resources`.
Each assignment has an exact `space` key and a `bundle` ID. Private assignments
apply to that user's UserSpace, including their solo groups, but never follow
them into a SharedSpace. Shared assignments apply to every conversation in that
SharedSpace and must contain only resources appropriate for that shared audience.
Unknown profiles, duplicate assignments, invalid paths and digest mismatches
fail validation. Missing configuration supplies no business defaults.

The host reads one immutable configuration snapshot at profile startup. To
update business assets, the deployment backs up and atomically replaces this
file under its existing drain/restart workflow, then restarts only that profile.
No Aria release, history migration, native configuration rewrite, or new
execution preparation is needed. Resource mounts, access ceilings, native
environment changes and identity policy still use their existing controlled
deployment/transition paths. This contract does not introduce live hot reload.

Only the first authorized execution in a Space triggers installation. Directory
creation, status, history queries, migration and startup probes do not install
business assets. A query-created native runtime is retired before installation,
with active query leases allowed to finish. Concurrent first runs share one
initializer. The profile runtime lock remains the sole physical writer lock;
offline writers must acquire the existing host ownership boundary.

## Small entry and lazy content

The business entry must fit **20 lines and 2048 UTF-8 bytes**. It should identify
the project/rules entry, resource index, skill index and output convention.
Detailed rules, skill bodies and large directory lists remain separate files.
Resource mappings describe deployment-admitted read-only paths; they do not
mount paths or grant access. External resources currently require the explicitly
admitted trusted-process deployment; isolated drivers reject resources outside
their execution root until an owned resource-mount contract supports them.

The materialized layout is:

```text
<Space>/control/
  workspace-setup.json                    owned file hashes and revision
  workspace-update.json                  pending transaction, removed on success
  workspace-revisions/<digest>.json       prior receipts
  workspace-discovery.json                native/canonical catalog result
<Space>/engine/workspace/
  AGENTS.md                              selected short entry, if safe to manage
  .aria/space-guide.md                    business entry for all engines
  .aria/resources.json                    resource mapping, no identities/tokens
  .aria/skills.md                         lazy skill catalog
  .aria/business/<bundle-id>/...          project-owned assets
  outputs/<scope-hash>/<run-hash>/         independent run outputs
```

Existing user `AGENTS.md` is preserved, including edits to a previously managed
entry. Five lines of run context point to the guide, indexes and that run's
output directory. No long business or skill bodies are injected, and no mutable
shared file carries run credentials, principal grants, conversation IDs or a
current-task output path. Existing output paths are retained for compatibility;
business skills can adopt the per-run output directory for new work.

Codex receives native copies under its isolated `.codex/skills` and must pass a
metadata-only `skills/list(forceReload)` check against the exact expected enabled
paths before execution. Other supported engines receive the explicit skill
catalog through their existing native prompt adapter. This is portable skill
delivery, not a claim of native slash-menu registration or live-engine
certification for those engines. No skill-discovery probe creates a thread or
model turn. Native homes, settings, histories and authentication are not copied.

## Existing spaces, recovery and rollback

Reconciliation checks every affected file before writing. Identical existing
assets may be adopted with their original contents recorded; only unchanged
managed files can be updated or removed. Removing management restores those
pre-existing contents and relinquishes ownership, so a previously restored skill
is not deleted when a new business assignment is rolled back.
User-edited files are preserved, and conflicts block installation/execution
with an operator-visible plan. Existing custom root `AGENTS.md` uses the separate
guide instead of blocking. The entire change set is journaled before mutation;
recovery accepts only the recorded before/after contents, completes an
interrupted transaction, and then reconciles the selected version. A conflicting
local edit prevents recovery rather than being overwritten.

Rollback selects the previous business definition through the same drained
profile restart and reconciles its assets. It does not restore an entire old
workspace or rewind sessions. Unassignment removes unchanged managed assets,
while retaining user outputs and custom root instructions. Disabling a business
assignment is not an OS credential revocation mechanism.

`inspectSelectedSpaceWorkspaces({rootDir, profileId})` is an operator-only public
API. It verifies the selected preparation, reports each assigned/existing space's
revision, diff, conflicts, resource availability and discovery state, and never
creates directories or starts a process. The workspace manifest is a derived
agent-readable guide; editing it cannot change the host assignment definition.
With trusted-process, the agent still shares host OS access. Directory names and
these receipt files do not establish OS-level tenant isolation.

## Verification

Unit coverage includes new and legacy spaces, bounded navigation, exact owner
assignment, solo/group routing, per-run output separation, cross-engine catalog
delivery, native discovery failure, changed files, unassignment, rollback,
interrupted writes, symlink refusal, read-only status and runtime acquisition
ordering. Deployment verification additionally exercises its real business
bundle and its installed native binary. Automated, native metadata, and human
platform acceptance are separate evidence categories.
