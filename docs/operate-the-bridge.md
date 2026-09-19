# Operate the bridge

> Status: current

> 中文版：[operate-the-bridge.zh.md](operate-the-bridge.zh.md)

Day-to-day operation of a running Aria installation: foreground vs. daemon
modes, profiles, the process registry, safe restarts, and the read-only
control-plane commands. All commands are listed in the
[CLI reference](CLI_REFERENCE.md).

## Two ways to run

- **`aria run`** — foreground bridge. Use it for first-run setup (the QR
  wizard) and debugging; stop it with `Ctrl-C`.
- **`aria start`** — installs (if needed) and starts an OS-managed daemon that
  survives logout and restarts on boot.

Both accept `--profile <name>` (defaults to the active profile) and
`--web-ui`, which runs the machine-wide Supervisor + local web console that
hosts all profiles instead of a single-profile headless run. See the
[web console guide](web-console.md).

Platform mapping for the daemon:

| Platform | Service |
| --- | --- |
| macOS | launchd user agent `ai.aria.bot.<profile>` |
| Linux | systemd user unit `aria.bot.<profile>.service` |
| Windows | Task Scheduler task `LarkChannelBridge.Bot.<profile>` via a `.cmd` wrapper |

Daemon logs live under `~/.aria/profiles/<profile>/logs/daemon/`. Tail them
with `aria logs [--profile <name>] [--lines <n>] [--follow]` (`--stdout` for
the stdout log, `--web-ui` for the Supervisor's).

## Service lifecycle

```bash
aria start [--profile <name>]      # install (if needed) + start the daemon
aria status [--profile <name>]     # pid, last exit, log paths
aria stop [--profile <name>]       # stop now; boot autostart stays on (add --keep-autostart to say so explicitly)
aria restart [--profile <name>]    # restart; refuses while work is active
aria unregister [--profile <name>] # remove the OS service registration
```

`aria restart` is safety-gated: it refuses when active work is detected.
Check first with the read-only preflight — exit code `0` means safe, `2`
blocked, `3` unavailable:

```bash
aria preflight restart [--profile <name>]
aria restart --force               # override only when you accept the risk
```

`stop`, `restart`, `status`, and `unregister` also accept `--web-ui` to target
the Supervisor service instead of a per-profile one (auto-detected when no
per-profile service exists).

## Process registry: `ps` and `kill`

Every local bridge process registers in `~/.aria/registry/processes.json`:

```bash
aria ps           # live bridge processes: id, pid, app, uptime, version
aria kill <id|#>  # SIGTERM, then SIGKILL after 2s
```

`kill` targets foreground (`aria run`) processes. When the target belongs to
an OS service, `kill` refuses — the service manager would respawn it within
seconds — and prints the correct `aria stop` / `aria restart` command instead.

## Profiles

A profile binds one PersonalAgent app, one engine, isolated credentials/state,
and its own workspaces and logs. Most installations need exactly one profile;
create more to run separate bots (e.g. Claude and Codex side by side) or to
connect multiple apps.

```bash
aria profile list
aria profile show [name]                       # redacted summary
aria profile create codex --agent codex        # interactive create also starts it on a running Supervisor
aria profile create codex --agent codex --no-start
aria profile start <name>                      # start on the running Supervisor
aria profile use <name>                        # set the active profile
aria profile remove <name>                     # archive local state (default)
aria profile remove <name> --purge --yes       # permanently delete
aria profile export <name>                     # secrets redacted by default
aria profile export <name> --include-secrets --yes
aria profile import <file> [--name <n>] [--app-secret <s>]
```

Notes that bite:

- If no Supervisor is running, start one with `aria start --web-ui`, then
  `aria profile start <name>`. Supervisor restarts restore profiles that were
  explicitly requested to run.
- `profile remove` on the active profile switches to the next profile; on the
  last profile it clears the root config.
- A profile created with the wrong `--agent` cannot be converted: stop or
  unregister its service first, `profile remove`, then recreate.
- `profile export` redacts app secrets unless `--include-secrets --yes`.
- `profile import` brings configuration and the app secret only — session
  history and workspace data do not travel in an export. For a full data
  migration use `aria space prepare`.

## Read-only inspection

```bash
aria inspect [--profile <name>] [--hours 24]   # lifecycle/concurrency summary from profile logs
aria runtime status [--profile <name>]         # profile lock + registered processes
aria config show [--profile <name>]            # redacted effective configuration
aria capabilities                              # supported control-plane operations
aria chat list [--profile <name>]              # chats the bot is in + mention overrides
aria engines                                   # engine ids accepted by --agent
aria doctor [--profile <name>]                 # aggregated health check (non-zero on failure)
```

All accept `--json` for automation (`aria doctor` exits non-zero when any
check fails).

## Changing configuration safely

Low-risk settings go through a staged protocol — nothing is written until a
plan is confirmed and applied:

```bash
aria config settings                          # list the settings this protocol accepts
aria config plan <setting> <value>            # create a redacted change plan
aria config plan-show <plan-id>
aria config confirm <plan-id>
aria config apply <plan-id>
```

The same `plan → confirm → apply` shape is used by `aria trigger` mutations
and the `aria update` lifecycle. Plans are redacted, expire, and are verified
again at apply time; the underlying `ManagementApi` contract is specified in
the [management control plane](CONTROL_PLANE.md) internals doc.

Per-chat mention overrides go through the same protocol — `aria chat mention
<chat_id> on|off` emits a sensitive-risk `profile.access.update` plan; finish
it with `aria config confirm <plan-id>` and `aria config apply <plan-id>`.

For other profile fields the protocol does not cover — `workspaces.default`,
`permissions.defaultAccess` / `permissions.maxAccess`, the rest of
`access.*` — edit the matching profile's field in `~/.aria/config.json`
(never replace the whole file) and restart the bridge or send `/reconnect` in
chat. The [README](../README.md#working-directories) documents those fields.

## Shell completion

```bash
aria completion bash   # or zsh / fish — prints the script to install
```

Hidden machine-facing commands (`worker`, `inbox`, `secrets get`,
`trigger agent`) and deprecated aliases (`control capabilities`) still work
but are omitted from `aria --help` and completion, same as the machine
protocols they serve.

`--app-secret` remains accepted on `run` / `start` / `profile create` /
`profile import` for automation; every use prints a stderr warning because
the value lands in shell history and process listings — prefer interactive
input or `aria secrets set` on shared machines.

## Troubleshooting

See the [troubleshooting guide](troubleshooting.md) for silent bots, frozen
runs, stale `aria` commands, and log locations.
