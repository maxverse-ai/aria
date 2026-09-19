# Aria CLI distribution architecture

> Status: current

> 中文版：[DISTRIBUTION.zh.md](DISTRIBUTION.zh.md)

Aria's current consumer channel is a private GitHub repository. GitHub Releases
is the package authority; npm is used only to resolve Aria's public runtime
dependencies while installing a verified release tarball. The Aria package is
not published to npm.

## Consumer workflow

### Bootstrap installation

The copy-paste bootstrap commands live in the bilingual
[README](../README.md#install). They perform three intentional steps:

1. use an already authenticated `gh` client to select the newest complete,
   published, immutable `internal-v*` prerelease;
2. download only that release's standalone `aria-install.mjs` bootstrapper;
3. let the bootstrapper independently resolve, download, verify, stage, smoke
   test, and activate the release package.

The bootstrapper accepts an optional exact stable version and an explicit
force flag:

```sh
node aria-install.mjs --version <x.y.z>
node aria-install.mjs --version <x.y.z> --force
```

`--force` is not a normal upgrade option. It permits an intentional downgrade
and carries the plan's explicit override into live-activity safety checks.
Without it, older targets and unsafe active-service transitions fail closed.

After installation, verify that the stable launcher wins command resolution:

```sh
command -v aria
aria --version
```

On PowerShell, use `Get-Command aria` for the first check. If an older npm/pnpm
global command still wins, move the installer-reported command directory ahead
of that global bin directory in `PATH` and open a new shell. The installer
retains an adopted legacy version as a rollback baseline; it does not delete
legacy files.

### Upgrade and rollback

The lifecycle is deliberately two-phase: `plan` resolves and verifies an exact
target, while `apply` revalidates the expiring plan immediately before a state
transition.

```sh
aria update check
aria update plan
aria update plan-show <plan-id>
aria update cancel <plan-id>
aria update apply <plan-id>
aria update status <operation-id>
aria update rollback
```

- `aria update plan --target-version <x.y.z>` selects an exact complete immutable
  release. The command prints the plan id, digest, expiry, and exact apply
  command.
- `aria update plan-show <plan-id>` reads a persisted plan back — its
  lifecycle state (`active`/`expired`/`cancelled`) and every operation that
  consumed it. `aria update cancel <plan-id>` marks an unapplied plan
  cancelled: the plan file is kept as evidence, `cancelledAt` is recorded,
  and `apply` rejects it. A plan that was already applied cannot be
  cancelled.
- `apply` and `rollback` use a detached OS executor by default so a service
  restart cannot terminate its own updater. `--foreground` is a recovery-only
  escape hatch.
- On Linux, the detached transient unit explicitly inherits `GH_CONFIG_DIR`
  when present so private-release revalidation uses the invoking CLI's isolated
  GitHub identity. Token environment variables are deliberately not copied into
  systemd unit metadata or process arguments.
- `status` without an id reads the latest journaled operation. Every command
  also supports `--json` for automation.
- `rollback` switches to the recorded previous version; it does not query a
  mutable “previous release” alias.

### Installation state

Executable state is machine-level and intentionally separate from profile
state. Defaults are:

| Platform | Install root | Stable command |
| --- | --- | --- |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/aria/cli` | `${XDG_BIN_HOME:-~/.local/bin}/aria` |
| macOS | `~/Library/Application Support/Aria/cli` | `${XDG_BIN_HOME:-~/.local/bin}/aria` |
| Windows | `%LOCALAPPDATA%\Aria\cli` | `%LOCALAPPDATA%\Aria\cli\bin\aria.cmd` |

Within the install root, `install.json` is the atomic active/previous pointer;
`versions/` contains commit-qualified installations; `plans/` and
`operations/` hold expiring plans and durable journals; and `bin/launcher.mjs`
is the stable service entrypoint. Override these roots only with
`ARIA_INSTALL_HOME` and `ARIA_BIN_HOME`; `ARIA_HOME` remains profile/runtime
state.

## Architecture boundaries

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

This separation lets profiles and encrypted credentials survive a CLI rollback,
and lets one machine installation update every registered profile service
without copying updater policy into the chat or engine layers.

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

The standalone bootstrapper is itself a release asset, not a source-checkout
script. Release verification copies it into a dependency-free temporary
directory and executes `--help`, so an installer that accidentally relies on
the repository's `node_modules` cannot pass the release gate.

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
