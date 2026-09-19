# Execution spaces

> Status: current

> 中文版：[execution-spaces.zh.md](execution-spaces.zh.md)

An **execution space** gives a conversation its own authorized execution
context — state, credentials, and history scoped to a Space rather than shared
across the whole profile. Personal and legacy team profiles keep one default
runtime; *prepared* spaces get their own runtime owners.

This is a deployment feature: `aria space` commands operate on a **private
deployment file** supplied by the host deployment, not on ad-hoc user input.
If you run a personal bot with a single agent, you do not need this page.

## Lifecycle

```bash
aria space status [--profile <name>]                     # current mode, retained preparations, legacy inventory
aria space list [--profile <name>]                       # all preparations: active, retained, staged
aria space prepare <deployment-file> [--profile <name>]  # stage + verify an immutable preparation (profile offline)
aria space inspect <selection-file> [--profile <name>]   # review a preparation, no state changes
aria space activate <selection-file> [--profile <name>]  # activate while the profile is stopped
aria space prepare-upgrade <deployment-file>             # backup + verify an offline prepared profile
aria space rollback [--profile <name>]                   # roll back the active preparation
```

All commands accept `--json`.

## How a migration flows

1. **Stop the profile.** `prepare` and `activate` run against an offline
   profile — the runtime lock must be free.
2. **`prepare <deployment-file>`** validates the deployment definition against
   the profile (the engine and workspace-access ceiling must match), probes
   the deployment, and stages an immutable preparation. Legacy data stays
   sealed unless a trusted migration adapter imports it; pending legacy
   triggers must be drained or paused first. `--id <preparation-id>` resumes
   an exact preparation — the same id is resumable only for identical inputs.
   The output is a private **selection file**.
3. **`inspect <selection-file>`** reviews the preparation without exposing
   private files or changing state.
4. **`activate <selection-file>`** commits the mode transition while the
   profile is stopped. `--accept-sealed-history` acknowledges that legacy
   history the adapter could not map stays sealed.
5. **`rollback`** restores the prior mode for the active preparation, and
   `status` lists retained preparations (each marked whether the legacy
   inventory changed since).

`prepare-upgrade` is the metadata-upgrade path for an already-prepared
profile: it backs up and verifies while keeping data and credential paths
stable. It requires an active preparation.

## What can go wrong

- **`profile is required`** — pass `--profile` when no active profile exists.
- **`deployment engine differs from profile`** / **`deployment access must
  match the effective native runtime ceiling`** — the deployment file must
  agree with the profile's `agentKind` and `permissions.defaultAccess`.
- **`legacy triggers must be drained or paused before space preparation`** —
  clear pending trigger work first.
- **`rollback the active preparation before preparing another migration`** —
  one active preparation at a time.
- **`an active preparation is required for upgrade`** — `prepare-upgrade` only
  applies to prepared profiles.
- A preparation that changed between stage and activation fails rather than
  activating stale state.

## Internals

Space semantics, runtime ownership, and the migration transaction are
specified in the [Execution space architecture](EXECUTION_SPACE_ARCHITECTURE.md).
Deployment-side workspace bundles and navigation live in
[Business workspace provisioning](SPACE_WORKSPACE_PROVISIONING.md) and
[Deployment-selected Space navigation](space-workspaces.md).
