# Install and upgrade

> Status: current

> 中文版：[install-and-upgrade.zh.md](install-and-upgrade.zh.md)

This guide covers the lifecycle of the `aria` binary itself: installing,
upgrading, rolling back, and removing it. For the first-run channel setup that
follows installation, see the [Quickstart](QUICKSTART.md).

## Install

Aria is distributed from private, immutable GitHub Releases and is not
published to npm. The copy-paste bootstrap commands live in the
[README](../README.md#install) and the [Quickstart](QUICKSTART.md); they:

1. use an already authenticated `gh` client to select the newest complete,
   published, immutable `internal-v*` prerelease;
2. download only that release's standalone `aria-install.mjs` bootstrapper;
3. let the bootstrapper independently resolve, download, verify, stage, smoke
   test, and activate the release package.

The installer delegates credentials to `gh` — Aria never reads or stores a
GitHub token. To pin an exact immutable release, add `--version <x.y.z>`; use
`--force` only for an intentional downgrade or when overriding an active-run
safety check.

After installation, verify that the stable launcher wins command resolution:

```bash
command -v aria
aria --version
```

On PowerShell, use `Get-Command aria`. If an older npm/pnpm global command
still wins, move the installer-reported command directory ahead of that global
bin directory in `PATH` and open a new shell. The installer retains an adopted
legacy version as a rollback baseline; it does not delete legacy files.

### Where things land

Executable state is machine-level and separate from profile state:

| Platform | Install root | Stable command |
| --- | --- | --- |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/aria/cli` | `${XDG_BIN_HOME:-~/.local/bin}/aria` |
| macOS | `~/Library/Application Support/Aria/cli` | `${XDG_BIN_HOME:-~/.local/bin}/aria` |
| Windows | `%LOCALAPPDATA%\Aria\cli` | `%LOCALAPPDATA%\Aria\cli\bin\aria.cmd` |

Within the install root, `install.json` is the atomic active/previous pointer
and `versions/` holds commit-qualified installations. Override these roots
only with `ARIA_INSTALL_HOME` and `ARIA_BIN_HOME`; `ARIA_HOME` stays reserved
for profile and runtime state (`~/.aria` by default), so profiles and
encrypted credentials survive a CLI rollback.

## Upgrade

The lifecycle is deliberately two-phase: `plan` resolves and verifies an exact
target, `apply` revalidates the expiring plan immediately before switching.

```bash
aria update check                    # is there a newer complete release?
aria update plan                     # download, verify, persist an expiring plan
aria update apply <plan-id>          # switch using a detached OS executor
aria update status [operation-id]    # inspect the journaled operation
```

- `aria update plan --target-version <x.y.z>` selects an exact release.
  `--force` allows an older target.
- `apply` and `rollback` use a detached OS executor by default so a daemon
  restart cannot kill its own updater; `--foreground` is a recovery-only
  escape hatch.
- Each apply rechecks live activity, release metadata, and package bytes.
  Failed health checks restore the previous version and service definitions.
- Every transition is journaled; `status` without an id reads the latest
  operation. All commands accept `--json` for automation.

## Roll back

```bash
aria update rollback
```

Rollback switches to the recorded previous installed version — it does not
query a mutable "previous release" alias. `--force` proceeds when live
activity cannot be proven safe.

## The OS service and upgrades

The daemon definition installed by `aria start` points at the stable launcher,
while the active version is selected through the atomically written
`install.json`. Service definitions therefore stay valid across upgrades and
rollbacks — no reinstallation needed. See
[Operate the bridge](operate-the-bridge.md) for the service commands.

## Uninstall

There is no single uninstall command today; removal is three explicit steps:

```bash
aria stop          # stop the daemon (repeat with --profile <name> / --web-ui per service)
aria unregister    # remove the OS service registration (same scoping)
```

Then delete the two independent roots:

- the install root and stable command from the table above;
- the profile state root — `~/.aria` by default, or `$ARIA_HOME` when set.

## Internals

The release contract, verification chain, detached executors, and transaction
journal are specified in the
[CLI distribution architecture](DISTRIBUTION.md).
