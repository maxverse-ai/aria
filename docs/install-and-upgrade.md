# Install and upgrade

> Status: current

> 中文版：[install-and-upgrade.zh.md](install-and-upgrade.zh.md)

This guide covers the lifecycle of the `aria` binary itself: installing,
upgrading, rolling back, and removing it. For the first-run channel setup that
follows installation, see the [Quickstart](QUICKSTART.md).

## Install

Aria is currently installed from source; the package is not yet published to
npm. Requires Node.js `>=24` and pnpm (`packageManager` pins `pnpm@12.0.0`):

```bash
git clone https://github.com/maxverse-ai/aria.git
cd aria
pnpm install
pnpm build
pnpm link --global
```

`pnpm link --global` exposes a stable `aria` command that resolves to the
checkout's `bin/aria.mjs`. Verify that it wins command resolution:

```bash
command -v aria
aria --version
```

On PowerShell, use `Get-Command aria`. If an older global command still wins,
move the pnpm global bin directory ahead of it in `PATH` and open a new shell.

### Where state lives

The working copy itself is the installation. Profile and runtime state is
kept separately under the profile root — `~/.aria` by default, or `$ARIA_HOME`
when set — so profiles and encrypted credentials survive a checkout reset or
a `pnpm unlink`.

## Upgrade

```bash
cd aria           # the clone
git pull
pnpm install && pnpm build
```

The daemon installed by `aria start` points at the linked launcher, so the
running service picks up the new build on its next restart
(`aria stop` / `aria start`). See
[Operate the bridge](operate-the-bridge.md) for the service commands.

## Roll back

```bash
cd aria
git checkout <previous-commit-or-tag>
pnpm install && pnpm build
```

The profile state root is untouched; restart the service afterwards.

## Uninstall

There is no single uninstall command today; removal is three explicit steps:

```bash
aria stop          # stop the daemon (repeat with --profile <name> / --web-ui per service)
aria unregister    # remove the OS service registration (same scoping)
```

Then:

- `pnpm unlink --global` (or `pnpm unlink --global @maxverse-ai/aria`) and
  delete the clone;
- delete the profile state root — `~/.aria` by default, or `$ARIA_HOME` when
  set.

## Update lifecycle

The `aria update` commands and the release machinery behind them are designed
for a versioned release channel. The earlier internal `internal-v*` GitHub
Release channel has been retired; once the first public `v*` release ships,
`aria update` manages upgrades and rollbacks against published immutable
GitHub Releases. Until then it reports no available releases. The release
contract, verification chain, detached executors, and transaction journal are
specified in the [CLI distribution architecture](DISTRIBUTION.md).
