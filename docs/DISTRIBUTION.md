# Aria local rollout

This machine-private fork is built and deployed only from its canonical local
repository. It has no remote update source and does not publish or install an
Aria package through GitHub or npm.

## Supported command

Run the rollout only from the clean `main` checkout of the canonical repository:

```sh
cd ***REMOVED***/project/aria
corepack pnpm local:rollout
```

The command builds the exact checked-out commit and schedules a detached Linux
systemd user unit. It does not interrupt active work: the worker waits up to ten
minutes for every affected profile to report an explicit safe restart decision.
Unknown runtime state fails closed by default.

An operator who has explicitly accepted interrupting active work may bypass only
that wait:

```sh
corepack pnpm local:rollout -- --force
```

Force mode still verifies the repository and payload, performs an atomic switch,
checks restarted services, and automatically restores the previous version on a
failed restart or health check.

The command rejects linked task worktrees, non-`main` branches, dirty worktrees,
and repositories with configured Git remotes. Release and deployment artifacts
must be built only after the exact candidate has passed ***REMOVED*** validation and
has been atomically integrated into local `main`.

A single task owner may run that full local rollout; no reviewer or separate
deploy-actor handoff is required. The detached executor, restart safety checks,
health verification, operation receipt, and automatic rollback remain
mandatory.

## Transaction

1. Build self-contained CLI and updater bundles from local source.
2. Copy only declared package files plus the one unbundled QR dependency into a
   private staging directory under the installation root.
3. Reject symlinks and hash the complete staged file inventory, permissions, and
   bytes with SHA-256.
4. Smoke-test the staged `aria --version` command.
5. Persist an expiring plan and operation journal, then start a detached worker.
6. Wait for all affected running services to become idle and recheck the active
   installation digest.
7. Atomically promote the staged tree into a commit-qualified version directory,
   recheck activity, and switch `install.json`.
8. Reconcile service definitions to the stable launcher, restart only services
   that were running, and require them to remain healthy.
9. If restart or health verification fails, restore the previous pointer and
   service definitions and restart the previous version.

The installed identity is `(package version, full Git commit, payload digest)`.
The directory is commit-qualified, so a local build never overwrites an existing
version directory merely because `package.json` has the same version.

## State layout

The existing machine installation layout is retained:

```text
~/.local/share/aria/cli/
├── install.json
├── bin/launcher.mjs
├── versions/<version>-<commit>/
├── staging/
├── downloads/<plan-id>/
├── plans/
└── operations/<operation-id>.json
```

Profile configuration, credentials, sessions, and logs remain under `ARIA_HOME`
and are not copied into deployment artifacts.

## Update commands

Remote discovery and apply commands fail closed in this fork:

```sh
aria update check
aria update plan
aria update apply <old-plan-id>
```

The local rollout is the only forward deployment path. The durable inspection
and recovery commands remain available:

```sh
aria update status [operation-id]
aria update rollback
```

Rollback switches to the already installed previous version and never queries a
network source. Old version directories are retained for recovery and forensic
inspection; cleanup is a separate operation.

## Deliberate scope

- Linux with a systemd user service only.
- One canonical, remote-free local repository.
- One host-level stable launcher and its registered profile/supervisor services.
- No release catalog, Git tags, remote registry, multi-ring rollout, package
  publication, or container deployment.

Containers and other hosts are independent deployment targets and are not
changed by the host-local rollout.
