# Aria CLI distribution architecture

Aria's current consumer channel is a private GitHub repository. GitHub Releases
is the package authority; npm is used only to resolve Aria's public runtime
dependencies while installing a verified release tarball. The Aria package is
not published to npm.

## Boundaries

- `src/application/distribution/` owns release, plan, install-state, operation,
  update, and rollback contracts. It depends only on ports.
- `src/platform/distribution/` implements GitHub/`gh`, filesystem, npm-tarball,
  stable-launcher, detached-executor, and OS-service adapters.
- `src/composition/distribution.ts` is the only production wiring root.
- `src/cli/commands/update.ts`, `src/installer/`, and `src/updater/` are thin
  delivery adapters. Feishu/Lark control can call the same application service
  later without duplicating update policy.

Profile state and executable state deliberately do not share a root:

- `ARIA_HOME`: profiles, credentials, sessions, logs, and runtime state.
- `ARIA_INSTALL_HOME`: downloaded releases, version directories, plans,
  operation journals, the stable launcher, and `install.json`.
- `ARIA_BIN_HOME`: optional stable command location.

## Release contract

A consumable release must be a published, immutable GitHub prerelease whose tag
is `internal-v<stable-semver>`. It must contain exactly the required contract
assets, including:

- the package tarball;
- `manifest.json` (exact build commit and package inventory);
- `SHA256SUMS`;
- `release.json` (schema, tag, version, commit, engine and rollback contract);
- `aria-install.mjs` (standalone bootstrapper).

The source adapter obtains credentials only by running `gh`. It never asks `gh`
for a token and never persists GitHub credentials. Mutable, draft, incomplete,
or incorrectly namespaced releases are invisible to consumers.

Verification cross-checks independently resolved tag/commit metadata,
`release.json`, the artifact manifest, the checksum file, and the actual
tarball bytes. A mismatch fails closed before npm or a service manager runs.

## Install and update transaction

1. `check` lists immutable internal releases and compares stable SemVer.
2. `plan` selects an exact release, downloads it, verifies it, snapshots the
   active digest and affected services, then writes an expiring plan.
3. `apply` reacquires the release and service facts, checks the plan's expected
   active digest, performs live restart-safety checks, and verifies the bytes
   again under a machine update lock.
4. npm installs the tarball with lifecycle scripts disabled into a staging
   directory. Aria smoke-tests the staged CLI and atomically promotes it into a
   commit-qualified version directory.
5. Aria writes stable launcher files, atomically switches `install.json`,
   rewrites existing service definitions to the stable launcher, restarts only
   services that were running, and checks that they remain alive.
6. Every transition is journaled. A failure after the switch restores the old
   pointer, service definitions, and running version. Installed version
   directories are retained for explicit rollback and forensic inspection.

`apply` and `rollback` normally launch `dist/updater.js` through a process that
does not belong to the daemon being restarted: a transient systemd user unit on
Linux, `launchctl submit` on macOS, or a detached process on Windows. The
foreground mode is an explicit recovery escape hatch.

## Legacy migration

The bootstrapper detects an existing npm/pnpm global `aria` executable through
`PATH`, resolves its package and version, and records it as the initial rollback
baseline. Existing profile and supervisor services are then rewritten to the
stable launcher only after the new release passes its smoke test. No legacy
files are deleted automatically.

## Extension points

Adding an enterprise artifact registry requires a new `ReleaseSource`; adding a
signature or transparency service requires a new/combined `ReleaseVerifier`;
adding another service manager or detached execution mechanism is confined to
platform adapters. The plan and operation schemas are versioned, so future
channels, rollout rings, signatures, or remote Feishu controls do not require a
second updater implementation.
