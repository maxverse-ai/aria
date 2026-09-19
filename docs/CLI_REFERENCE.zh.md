# CLI 命令参考

> Status: current — 由 `site/scripts/gen-cli-reference.mjs` 依据 `src/cli/index.ts` 自动生成；修改 CLI 后运行 `node site/scripts/gen-cli-reference.mjs` 重新生成。请勿手工编辑。

> English version: [CLI_REFERENCE.md](CLI_REFERENCE.md)

以下每个命令都与 `src/cli/index.ts` 中的 Commander 声明逐一对应。`aria <command> --help` 是权威用法说明；命令与选项描述保留英文原文以便与帮助输出对照。

## 全局

- `aria --version`（`-v`）— 打印已安装版本。
- `aria <command> --help` — 打印任意命令的用法。
- 标记 `--json` 的读取类命令输出机器可读 JSON。

## `aria run`

Run the bridge in the foreground (was `start` in older versions)

| 选项 | 说明 |
| --- | --- |
| `-c, --config <path>` | path to config file |
| `--profile <name>` | profile name to run |
| `--web-ui` | run the machine-wide supervisor + local web console (hosts all profiles); default is a single-profile headless run |
| `--agent <kind>` | engine plugin id for a new profile (claude, codex, ...) |
| `--workspace <path>` | initial working directory for first-run profile bootstrap |
| `--app-id <id>` | use an existing Lark/Feishu app instead of QR app creation |
| `--app-secret <secret>` | App Secret for --app-id; prefer interactive input on shared machines |
| `--tenant <tenant>` | tenant for --app-id (feishu or lark; default feishu) |
| `--skip-check-lark-cli` | skip lark-cli pre-flight check (auto-install + bind) |

## `aria profile`

Manage local bridge profiles

### `aria profile show [name]`

Show a redacted profile summary (read-only)

| 选项 | 说明 |
| --- | --- |
| `--json` | print stable machine-readable JSON |

### `aria profile list`

List configured profiles

### `aria profile create <name>`

Create a profile; interactive terminals also start it on the existing Supervisor

| 选项 | 说明 |
| --- | --- |
| `--start` | start on the existing Supervisor after creation (also in scripts) |
| `--no-start` | save configuration only; do not start the profile |
| `--agent <kind>` | engine plugin id (claude, codex, ...) |
| `--workspace <path>` | initial working directory for this profile |
| `--app-id <id>` | use an existing Lark/Feishu app instead of QR app creation |
| `--app-secret <secret>` | App Secret for --app-id; prefer interactive input on shared machines |
| `--tenant <tenant>` | tenant for --app-id (feishu or lark; default feishu) |

### `aria profile start <name>`

Start an existing profile on the running Supervisor

### `aria profile use <name>`

Set the active profile

### `aria profile remove <name>`

Archive a profile and its local state

| 选项 | 说明 |
| --- | --- |
| `--purge` | permanently delete profile state instead of archiving |
| `--yes` | confirm destructive profile deletion |

### `aria profile export <name>`

Export one profile as JSON

| 选项 | 说明 |
| --- | --- |
| `--output <path>` | write export JSON to a file instead of stdout |
| `--force` | overwrite an existing output file |
| `--include-secrets` | include secret provider configuration and app secret values |
| `--yes` | confirm exporting secrets |

## `aria ui`

Open the local web console (config, profiles, online bots) in your browser

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name (defaults to active profile) |
| `--print` | print the URL instead of opening a browser |

## `aria ps`

List running bridge processes on this machine

## `aria inspect`

Summarize profile-local lifecycle and concurrency events (read-only)

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name (defaults to active profile) |
| `--hours <number>` | lookback window in hours (default: `24`) |
| `--json` | print machine-readable JSON |

## `aria inbox`

Read the per-scope steering mailbox (agent-facing pull side)

### `aria inbox check`

Report the unread steering count for this scope

| 选项 | 说明 |
| --- | --- |
| `--scope <scope>` | conversation scope (defaults to ARIA_INBOX_SCOPE) |
| `--dir <path>` | mailbox directory (defaults to the profile inbox layout) |
| `--json` | print machine-readable JSON |

### `aria inbox pull`

Print every unread steering body and mark it pulled

| 选项 | 说明 |
| --- | --- |
| `--scope <scope>` | conversation scope (defaults to ARIA_INBOX_SCOPE) |
| `--dir <path>` | mailbox directory (defaults to the profile inbox layout) |
| `--json` | print machine-readable JSON |

## `aria control`

Discover Aria control-plane capabilities

### `aria control capabilities`

List supported control-plane operations (read-only)

| 选项 | 说明 |
| --- | --- |
| `--json` | print stable machine-readable JSON |

## `aria trigger`

Discover trigger-platform contracts and capabilities

### `aria trigger capabilities`

List shipped trigger-platform capabilities (read-only)

| 选项 | 说明 |
| --- | --- |
| `--json` | print stable machine-readable JSON |

### `aria trigger list`

List trigger definitions and run counts

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | filter by profile |
| `--json` | print machine-readable JSON |

### `aria trigger get <id>`

Read one trigger and its history

| 选项 | 说明 |
| --- | --- |
| `--json` | print machine-readable JSON |

### `aria trigger history [id]`

Read trigger occurrence history

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | filter by profile |
| `--json` | print machine-readable JSON |

### `aria trigger preview <id>`

Preview future fire times

| 选项 | 说明 |
| --- | --- |
| `--count <number>` | number of fire times (default: `5`) |
| `--json` | print machine-readable JSON |

### `aria trigger plan <command>`

Create a redacted trigger mutation plan

| 选项 | 说明 |
| --- | --- |
| `--input <json> *(required)*` | private JSON command input |
| `--json` | print machine-readable JSON |

### `aria trigger plan-show <planId>`

Show a redacted trigger mutation plan

| 选项 | 说明 |
| --- | --- |
| `--json` | print machine-readable JSON |

### `aria trigger confirm <planId>`

Confirm a trigger mutation plan

| 选项 | 说明 |
| --- | --- |
| `--json` | print machine-readable JSON |

### `aria trigger apply <planId>`

Apply a confirmed trigger mutation plan

| 选项 | 说明 |
| --- | --- |
| `--json` | print machine-readable JSON |

### `aria trigger execute <command>`

Plan, confirm and apply create/update/pause/resume/cancel/run-now/retry/ack

| 选项 | 说明 |
| --- | --- |
| `--input <json> *(required)*` | private JSON command input |
| `--yes *(required)*` | confirm mutation |
| `--json` | print machine-readable JSON |

### `aria trigger grant`

Issue and revoke bounded Agent trigger capabilities

#### `aria trigger grant issue`

Issue a bearer grant; the token is shown once

| 选项 | 说明 |
| --- | --- |
| `--input <json> *(required)*` | profile, engine, principal, expiry and limits |
| `--yes *(required)*` | confirm grant issuance |
| `--json` | print machine-readable JSON |

#### `aria trigger grant list`

List issued Agent trigger grants (read-only)

| 选项 | 说明 |
| --- | --- |
| `--json` | print machine-readable JSON |

#### `aria trigger grant get <id>`

Read one Agent trigger grant (read-only)

| 选项 | 说明 |
| --- | --- |
| `--json` | print machine-readable JSON |

#### `aria trigger grant revoke <id>`

Revoke an Agent trigger grant

| 选项 | 说明 |
| --- | --- |
| `--yes *(required)*` | confirm grant revocation |
| `--json` | print machine-readable JSON |

### `aria trigger agent <command>`

Execute a grant-scoped create/list/history/snooze/update/cancel operation

| 选项 | 说明 |
| --- | --- |
| `--engine <id> *(required)*` | calling engine id |
| `--input <json>` | command input (default: `{}`) |
| `--yes` | confirm a mutation |
| `--json` | print machine-readable JSON |

### `aria trigger schema <name>`

Show a versioned trigger contract schema (read-only)

| 选项 | 说明 |
| --- | --- |
| `--json` | print stable machine-readable JSON |

## `aria config`

Inspect effective profile configuration

### `aria config show`

Show a redacted effective configuration snapshot (read-only)

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name (defaults to active profile) |
| `--json` | print stable machine-readable JSON |

### `aria config settings`

List low-risk settings accepted by the change protocol

| 选项 | 说明 |
| --- | --- |
| `--json` | print stable machine-readable JSON |

### `aria config plan <setting> <value>`

Create a low-risk configuration change plan without applying it

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name (defaults to active profile) |
| `--json` | print stable machine-readable JSON |

### `aria config plan-show <plan-id>`

Show a redacted persisted configuration change plan

| 选项 | 说明 |
| --- | --- |
| `--json` | print stable machine-readable JSON |

### `aria config confirm <plan-id>`

Explicitly confirm a configuration change plan

| 选项 | 说明 |
| --- | --- |
| `--json` | print stable machine-readable JSON |

### `aria config apply <plan-id>`

Apply a confirmed configuration change plan

| 选项 | 说明 |
| --- | --- |
| `--json` | print stable machine-readable JSON |

## `aria space`

Prepare, activate and roll back execution spaces

### `aria space status`

Show execution-space status, retained preparations, and legacy inventory

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name |
| `--json` | print machine-readable metadata |

### `aria space rollback`

Roll back the active execution-space preparation

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name |
| `--json` | print machine-readable metadata |

### `aria space prepare <deployment-file>`

Stage and verify an offline profile; legacy data stays sealed unless imported by a trusted adapter

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name |
| `--id <id>` | resume an exact preparation id |
| `--json` | print preparation selection |

### `aria space activate <selection-file>`

Activate an immutable preparation while the profile is stopped

| 选项 | 说明 |
| --- | --- |
| `--accept-sealed-history` | acknowledge that unmapped legacy history stays sealed |
| `--profile <name>` | profile name |
| `--json` | print machine-readable metadata |

### `aria space prepare-upgrade <deployment-file>`

Back up and verify an offline prepared profile while preserving its data and credential paths

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name |
| `--id <id>` | resume an exact upgrade preparation id |
| `--json` | print preparation selection |

### `aria space inspect <selection-file>`

Review a preparation without exposing private files or changing state

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name |
| `--json` | print machine-readable metadata |

## `aria runtime`

Inspect managed runtime state

### `aria runtime status`

Show profile runtime lock and registered processes (read-only)

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name (defaults to active profile) |
| `--json` | print stable machine-readable JSON |

## `aria worker`

Run Aria as a channel-free managed worker

### `aria worker discover`

List configured worker identities as secret-free JSON

| 选项 | 说明 |
| --- | --- |
| `--config <path> *(required)*` | path to the Aria root config |

### `aria worker serve`

Serve newline-delimited JSON-RPC over stdin/stdout

| 选项 | 说明 |
| --- | --- |
| `--config <path> *(required)*` | path to the Aria root config |
| `--profile <name> *(required)*` | profile whose engine and local policy are used |
| `--state-dir <path> *(required)*` | isolated worker session and log state |

## `aria preflight`

Check whether a potentially disruptive operation is safe

### `aria preflight restart`

Check live daemon activity before restart (read-only)

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name (defaults to active profile) |
| `--json` | print stable machine-readable JSON |

## `aria kill <target>`

Kill a running bridge process by short id or list index (SIGTERM, then SIGKILL after 2s). Was `stop <target>` in older versions.

## `aria start`

Install (if needed) and start the bridge as an OS-managed daemon

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name (defaults to active profile) |
| `--web-ui` | run the supervisor + web console as the background service (hosts all profiles) instead of a single profile |
| `--agent <kind>` | engine plugin id for first-run bootstrap (claude, codex, ...) |
| `--workspace <path>` | initial working directory for first-run profile bootstrap |
| `--app-id <id>` | use an existing Lark/Feishu app instead of QR app creation |
| `--app-secret <secret>` | App Secret for --app-id; prefer interactive input on shared machines |
| `--tenant <tenant>` | tenant for --app-id (feishu or lark; default feishu) |
| `--skip-check-lark-cli` | skip lark-cli pre-flight check (auto-install + bind) |

## `aria stop`

Stop the OS-managed daemon and disable autostart (service definition stays)

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name (defaults to active profile) |
| `--web-ui` | target the supervisor service (auto-detected when no per-profile service exists) |

## `aria restart`

Restart the OS-managed daemon

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name (defaults to active profile) |
| `--web-ui` | target the supervisor service instead of a per-profile one |
| `--force` | restart even when active work is detected or state is unavailable |
| `--json` | print a machine-readable safety report when restart is refused |

## `aria status`

Show OS service status (pid, last exit, log paths)

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name (defaults to active profile) |
| `--web-ui` | target the supervisor service instead of a per-profile one |

## `aria unregister`

Remove the OS service registration (bootout + delete plist)

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name (defaults to active profile) |
| `--web-ui` | target the supervisor service instead of a per-profile one |

## `aria update`

Check, plan, apply, and roll back versioned Aria installations

### `aria update check`

Check the newest complete immutable internal release

| 选项 | 说明 |
| --- | --- |
| `--json` | print machine-readable JSON |

### `aria update plan`

Download, verify, and persist an expiring update plan

| 选项 | 说明 |
| --- | --- |
| `--target-version <version>` | select an exact stable version |
| `--force` | allow an older target version |
| `--json` | print machine-readable JSON |

### `aria update apply <plan-id>`

Apply a verified update plan using a detached OS executor

| 选项 | 说明 |
| --- | --- |
| `--foreground` | run in the current process (recovery use only) |
| `--json` | print machine-readable JSON |

### `aria update status [operation-id]`

Show the latest or selected update operation

| 选项 | 说明 |
| --- | --- |
| `--json` | print machine-readable JSON |

### `aria update rollback`

Atomically switch back to the previous installed version

| 选项 | 说明 |
| --- | --- |
| `--force` | proceed when live activity cannot be proven safe |
| `--foreground` | run in the current process (recovery use only) |
| `--json` | print machine-readable JSON |

## `aria secrets`

Manage the bridge's encrypted secret keystore (~/.aria/secrets.enc)

### `aria secrets get`

Exec-provider protocol: read JSON request from stdin, write JSON response to stdout. Used by lark-cli config bind --source lark-channel.

### `aria secrets set`

Encrypt and store an App Secret. Prompts for the secret without echoing.

| 选项 | 说明 |
| --- | --- |
| `--app-id <id> *(required)*` | App ID (e.g. cli_xxxxxxxxxxxx) |
| `--profile <name>` | profile name (defaults to active profile) |

### `aria secrets list`

List the IDs of secrets in the encrypted keystore (no secrets shown)

| 选项 | 说明 |
| --- | --- |
| `--profile <name>` | profile name (defaults to active profile) |

### `aria secrets remove`

Delete an entry from the encrypted keystore

| 选项 | 说明 |
| --- | --- |
| `--app-id <id> *(required)*` | App ID to remove |
| `--yes *(required)*` | confirm secret deletion |
| `--profile <name>` | profile name (defaults to active profile) |
