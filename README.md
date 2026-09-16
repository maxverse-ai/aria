# Aria

**English** | [简体中文](./README.zh.md)

[![Focus](https://img.shields.io/badge/focus-local--first%20agent%20control-7C5CFC?style=flat-square&labelColor=171717)](#why-aria)
[![Channels](https://img.shields.io/badge/channels-pluggable-00D6B9?style=flat-square&labelColor=171717)](#runtime-flow)
[![Platforms](https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-55DDE0?style=flat-square&labelColor=171717)](#supported-scope)
[![Distribution](https://img.shields.io/badge/distribution-immutable%20GitHub%20Releases-F3B61F?style=flat-square&labelColor=171717)](#install)

**A local-first control plane for coding agents. Chat is the remote control, not
the compute plane.**

Aria turns a chat surface into the interaction surface for coding agents that
run on your own machine. The engine, tools, files, and credentials stay local;
Aria owns message addressing, access control, profiles, sessions, workspaces,
streaming delivery, turn coordination, background services, and safe version
lifecycle operations. Channels are pluggable: Lark / Feishu ships built in, and
the channel plugin ABI is the extension boundary.

The sharp product contract is:

> Send an addressed task from chat, route it to the correct local agent and
> workspace, incorporate eligible follow-ups without losing queued input, and
> publish the terminal answer only while it is still fresh.

[Why Aria](#why-aria) | [Product contract](#product-contract) |
[Runtime flow](#runtime-flow) | [Supported scope](#supported-scope) |
[Quick start](#quick-start) | [Commands](#commands) |
[Documentation](#documentation)

## Why Aria

- **Local execution:** source trees, agent credentials, shell tools, and
  attachments stay on the host that runs Aria; chat is the remote control, not
  the compute plane.
- **Capability-driven engines:** every engine plugin advertises its own
  history, image, service-tier, and live-input capabilities. The UI renders
  only controls the selected engine and model actually support.
- **Safe steering and fallback:** eligible text sent during Codex and Grok runs
  can be accepted by their native live-input transports; an unsupported,
  delayed, or rejected input remains owned by the next-turn queue instead of
  disappearing.
- **Conversation isolation:** each chat, topic, or document-comment thread has
  an independent session, while profiles isolate app credentials, agent state,
  workspaces, logs, and channel tool identity.
- **Observable delivery:** streaming cards, optional COT process messages,
  tool blocks, run status, and terminal freshness checks make the remote run
  understandable without pretending provisional output is final.
- **Operational safety:** immutable release metadata, byte verification,
  stable launchers, detached updates, health checks, and transactional rollback
  keep a running bot recoverable.
- **Private by default:** the app owner is the only chat user initially;
  explicit user, group, and admin grants expand access.

## Product Contract

These are stable product surfaces, not agent-specific shortcuts:

| Surface | Contract |
| --- | --- |
| Channel | Normalize a channel's direct messages, groups, topics, comments, mentions, files, and card actions into addressed conversation input |
| Profile | Bind one PersonalAgent app, one engine, isolated credentials/state, and a default or named workspace set |
| Engine plugin | Probe and start a local CLI, advertise capabilities, stream events, resume compatible history, and dispose owned resources |
| Turn coordinator | Batch initial input, preserve one-owner inbox semantics, offer eligible live follow-ups, and safely queue every fallback |
| Delivery | Stream provisional progress, project agent-reported status, check final-reply freshness, and suppress conservative duplicates |
| Policy | Apply chat access, group addressing, workspace validation, permission ceilings, and identity boundaries before execution |
| Distribution | Resolve complete immutable releases, verify metadata and bytes, switch a stable launcher atomically, and roll back failed updates |

Engine-specific behavior stays behind the engine contract. Channel routing,
access policy, coordination, and the updater do not branch on a hard-coded
global “Fast” or “steering” switch.

## Runtime Flow

```text
human in chat
        │
        ▼
channel normalization → access + addressing → profile / session / workspace
                                                  │
                                                  ▼
                                      capability-driven engine plugin
                                                  │
                                                  ▼
                                        local coding-agent CLI
                                                  │
                    ┌─────────────────────────────┴──────────────────────┐
                    ▼                                                    ▼
        streamed progress + status                         addressed follow-up
                    │                                      │
                    │                         native steer if acknowledged;
                    │                         otherwise retain for next turn
                    └─────────────────────────────┬──────────────────────┘
                                                  ▼
                               inbox + bounded-thread freshness gate
                                                  ▼
                                           terminal reply
```

## Supported Scope

| Built-in engine | Current live follow-up behavior | Engine-specific surface |
| --- | --- | --- |
| Claude Code | Retained for the next turn | Native history and compatible resume |
| Codex CLI | Direct text steering through App Server `turn/steer` | Image input and model-reported service tiers such as Fast |
| Grok Build | Direct text steering through Agent stdio | ACP sessions, image input, and live model discovery |
| OpenCode | Retained for the next turn | Native history and live model discovery |
| DeepSeek Harness | Retained for the next turn | Built-in headless adapter |
| Kimi Code | Retained for the next turn | Claude-compatible transport and native history |
| Pi | Retained for the next turn | Native history and reasoning controls |

All built-in engines share channel routing, access control, profiles,
workspaces, queue/freshness safety, streaming, and service management. Native
steering is currently text-only for Codex and Grok. Fast is not a generic Aria
speed flag: it appears only when Codex App Server reports a compatible service
tier for the selected model.

The current product boundary is deliberately explicit:

- one local host owns execution; Aria is not a hosted multi-tenant agent cloud;
- Lark / Feishu PersonalAgent ships built in and is the production channel
  today; WeChat Customer Service and external channel plugins use the same
  channel contracts;
- multi-person groups require a structured `@bot` for unambiguous addressing;
- remote freshness history is bounded and fails open when unavailable or
  truncated, so history failure never silently discards a terminal answer;
- Aria is distributed from private immutable GitHub Releases and is not
  published to npm.

## Quick Start

### Prerequisites

- Node.js **>= 24.0.0**
- At least one local agent installed and logged in:
  - Claude Code: `claude`, see https://docs.anthropic.com/en/docs/claude-code/quickstart
  - Codex CLI: `codex`, see https://developers.openai.com/codex/cli
  - Grok Build: `grok`, see https://docs.x.ai/build/cli/
  - OpenCode CLI: `opencode`, see https://opencode.ai/docs/
  - DeepSeek Harness (`dsh`), Kimi Code (`kimi`), and Pi (`pi`) are also
    built-in when their corresponding CLI is installed.
- A Feishu / Lark **PersonalAgent** app. The first-run QR wizard can create and bind one for you.

### Install

Aria is currently distributed from private, immutable GitHub Releases; the
Aria package itself is not published to npm. First authenticate GitHub CLI with
an account that can read `maxverse-ai/aria`, then download the standalone
installer from the newest complete internal release:

Linux / macOS:

```bash
gh auth status
ARIA_REPOSITORY=maxverse-ai/aria
ARIA_TAG="$(gh api "repos/$ARIA_REPOSITORY/releases?per_page=100" --jq 'map(select(.draft == false and .prerelease == true and .immutable == true and (.tag_name | startswith("internal-v")))) | sort_by(.tag_name | ltrimstr("internal-v") | split(".") | map(tonumber)) | last.tag_name')"
ARIA_INSTALL_TMP="$(mktemp -d)"
gh release download "$ARIA_TAG" --repo "$ARIA_REPOSITORY" --pattern aria-install.mjs --dir "$ARIA_INSTALL_TMP"
node "$ARIA_INSTALL_TMP/aria-install.mjs"
```

<details>
<summary>Windows PowerShell</summary>

```powershell
gh auth status
$AriaRepository = "maxverse-ai/aria"
$AriaTag = gh api "repos/$AriaRepository/releases?per_page=100" --jq 'map(select(.draft == false and .prerelease == true and .immutable == true and (.tag_name | startswith("internal-v")))) | sort_by(.tag_name | ltrimstr("internal-v") | split(".") | map(tonumber)) | last.tag_name'
$AriaInstallTmp = Join-Path ([System.IO.Path]::GetTempPath()) ("aria-install-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $AriaInstallTmp | Out-Null
gh release download $AriaTag --repo $AriaRepository --pattern aria-install.mjs --dir $AriaInstallTmp
node (Join-Path $AriaInstallTmp "aria-install.mjs")
```

</details>

The installer delegates credentials to `gh`; Aria never reads or stores a
GitHub token. It installs versioned packages under a platform data directory
and writes a stable `aria` launcher (normally `~/.local/bin/aria` on Linux and
macOS). Add the printed command directory to `PATH` if needed, then verify the
selected launcher and version:

```bash
command -v aria
aria --version
```

To pin an exact immutable release, add `--version <x.y.z>` to the installer
command. Use `--force` only for an intentional downgrade or when overriding an
active-run safety check.

To upgrade or roll back later:

```bash
aria update check
aria update plan
aria update apply <plan-id>
aria update status <operation-id>
aria update rollback
```

`apply` and `rollback` use an OS-detached executor by default, so updating a
running daemon cannot kill its own updater. Each apply rechecks live activity,
release metadata, and package bytes; failed health checks restore the previous
version and service definitions.

### First run

```bash
aria run
```

The first run opens a QR-code wizard:

1. A QR code renders in your terminal.
2. Scan it with the Feishu / Lark app.
3. Pick or create a PersonalAgent app.
4. If prompted, choose which agent to initialize.
5. Config is written to `~/.aria/config.json`.

You do not need to choose a project directory up front. The bridge creates a
profile-managed default working directory with an identity-neutral `AGENTS.md`,
`README.md`, and `scratch/`; after startup, send `/cd <path>` in Feishu / Lark
to switch to a real project.

If you already have a PersonalAgent app, pass `--app-id` during initialization to skip app creation. The command prompts for the App Secret.

```bash
aria run --app-id cli_xxx
# or initialize and start the background service directly
aria start --app-id cli_xxx
```

For Lark global apps, add `--tenant lark`.

### Background service

Use `run` for first-run setup and foreground debugging. After the bot can send and receive messages, stop the foreground process with `Ctrl-C`, then use an OS-managed service for background operation:

```bash
aria start
aria status
aria stop
```

Install with the versioned GitHub Release installer before using service
commands. The daemon definition points to Aria's stable launcher, while the
active version is selected through an atomically written install-state file.
This keeps service definitions valid across upgrades and rollbacks.

Service commands install a per-profile service:

```bash
aria start [--profile <name>]
aria stop [--profile <name>]
aria restart [--profile <name>]
aria status [--profile <name>]
aria unregister [--profile <name>]
```

Platform mapping:
- **macOS**: launchd user agent `ai.aria.bot.<profile>`
- **Linux**: systemd user unit `aria.bot.<profile>.service`
- **Windows**: Task Scheduler task `LarkChannelBridge.Bot.<profile>`, launched through a `.cmd` wrapper

Daemon logs are under `~/.aria/profiles/<profile>/logs/daemon/`.

#### Multiple profiles: Claude and Codex

By default, the bridge starts with the currently selected profile. Use `profile use <name>` to change it. Each profile keeps its own app credentials, sessions, working directories, and logs. Create multiple profiles only when you need to connect multiple PersonalAgent apps, or run Claude and Codex as separate bots:

```bash
aria start --profile claude --agent claude
aria start --profile codex --agent codex
```

For example, to restart only the Codex bot:

```bash
aria restart --profile codex
aria status --profile codex
```

## Commands

### Host CLI

```text
aria run [--profile <name>] [--agent <kind>] [--workspace <path>] [-c <config>]
aria ui [--profile <name>] [--print]
aria inspect [--profile <name>] [--hours <number>] [--json]
aria control capabilities [--json]
aria config show [--profile <name>] [--json]
aria runtime status [--profile <name>] [--json]
aria preflight restart [--profile <name>] [--json]
aria ps
aria kill <id|#>
aria --help
```

The first line runs a foreground bridge. The remaining read-only control-plane
commands expose the browser console URL, lifecycle evidence, stable capability
catalog, redacted effective config, managed runtime state, and restart safety
without requiring consumers to parse Aria's internal files. See the
[control-plane document](docs/CONTROL_PLANE.md) for the plan/confirm/apply
configuration protocol.

`profile use <name>` changes the profile used by later default starts. Use these profile management commands when running separate Claude / Codex bots, connecting multiple PersonalAgent apps, or doing scripted deployment:

```bash
aria profile create claude --agent claude
aria profile create codex --agent codex
aria profile list
aria profile use <name>
aria profile remove <name>
aria profile remove <name> --purge --yes
aria profile export <name> [--output ./profile.json] [--force]
aria profile export <name> --include-secrets --yes
```

Interactive `profile create` saves configuration and then starts the profile on the
existing Supervisor. Use `--no-start` to save only; non-interactive scripts save
only by default and can opt in with `--start`. If startup fails, the configuration
is retained and the command reports failure with a retry command:

```bash
aria profile start <name>
```

If no Supervisor is running, start it with `aria start --web-ui`, then retry.
A successful start confirms runtime startup; send a message to verify an actual
engine reply. Supervisor restarts restore profiles explicitly requested to run;
profiles explicitly stopped remain stopped. On the first startup without a
running-intent record, only the active profile starts, preserving prior behavior.

`profile remove` archives local state by default, including the active profile. If other profiles remain, the bridge switches to the next one; if it was the last profile, the root config is cleared so the same name can be created again. `--purge --yes` permanently deletes local state. `profile export` redacts app secrets by default; `--include-secrets --yes` includes sensitive config.

If a profile was created with the wrong agent kind, stop or unregister any matching background service first, then run `profile remove <name>` and recreate it with the intended `--agent`.

### Slash commands in a channel

| Command | Effect |
|---|---|
| `/new [task]`, `/reset` | Start a fresh session; optionally submit a new task immediately |
| `/task <goal> [--target <agent>] [--participants <ids>] [--max-rounds <n>]` | Create a task and enter its task thread |
| `/cd <path>` | Switch working directory and reset the session |
| `/ws list` | List named workspaces |
| `/ws save <name>` | Save the current working directory as a named workspace |
| `/ws use <name>` | Switch to a named workspace |
| `/ws remove <name>` | Delete a named workspace |
| `/resume` | Resume compatible history for the same agent, working directory, and permission mode |
| `/status` | Show profile, agent, working directory, session, lark-cli identity, and run state |
| `/agent` | Switch the engine this profile runs, staged so the current run finishes first |
| `/models` | Inspect and select the model |
| `/effort` | Inspect and select the reasoning effort |
| `/config` | Adjust presentation preferences, access settings, and lark-cli identity policy |
| `/account` | Show the bound app; `/account change` replaces its appId and secret and reconnects |
| `/fast [on\|off\|status\|reset]` | Manage Codex Fast for models that expose service tiers (admin only) |
| `/invite user @name` | Allow a user to use the bot in DMs |
| `/invite admin @name` | Add an access-control admin |
| `/invite group` | Allow the current group to use the bot |
| `/invite all group` | Allow all groups the bot has joined |
| `/remove user @name`, `/remove admin @name`, `/remove group` | Remove access entries |
| `/stop` | Stop the current run, including the card stop button |
| `/timeout [N\|off\|default]` | Set or clear the current session idle watchdog |
| `/ps` | List local bridge processes |
| `/exit <id\|#>` | Stop a bridge process |
| `/reconnect` | Force a WebSocket reconnect |
| `/doctor [description]` | Run low-sensitive diagnostics |
| `/doc` | Explain how cloud-document comments reach the agent |
| `/remind at <ISO time> <task>` | Create a session-anchored reminder; `list`, `snooze`, `update`, `cancel`, and `history` manage it |
| `/meeting` | Join a Feishu video meeting by number, leave it, inspect what was captured, or ask with the transcript as context (admin only) |
| `/help` | Help card |

DMs and groups containing exactly one human plus the current bot are addressed implicitly. In every other group or topic group, only a structured `@bot` addresses the agent; replying to an agent message without @ adds context but does not address it. Ambient group messages are ignored by default. Opting into ambient group intake requires the app scope `im:message.group_msg`; `@all` is ignored. Cloud-doc comments in supported document types run when the bot is mentioned.

Codex Fast uses the live model capability catalog: `/fast on` enables it, `/fast off` explicitly selects the standard tier, and `/fast reset` follows Codex's own configuration again. The reply status line shows the `Fast on/off` value actually accepted by App Server. Other agents, and older Codex versions that do not report service tiers, omit the item.

During a supported active run, eligible text follow-ups addressed to the agent are merged automatically. Aria removes a message from the next-turn queue only after the engine acknowledges it; unsupported, deferred, or rejected attempts safely remain queued. Use `/new <task>` when the message should begin a separate task instead.

Before publishing a terminal reply, Aria also checks the local inbox and a bounded snapshot of the exact chat or topic thread. New addressed human input holds the stale reply and continues in the next turn; a verbatim matching answer from another bot suppresses the duplicate. Ambient multi-person group traffic does not hold replies, and unavailable or truncated history fails open.

## Reply Display and COT

`/config` controls three presentation settings:

- **Message reply mode**: `message card` streams the final reply; `plain text` sends once after the run finishes.
- **Tool-call display**: controls whether tool blocks appear in the final card / markdown reply.
- **COT process message**: `detailed` is the default and includes agent progress text, tool arguments, and truncated output; `brief` keeps only progress text and tool summaries; `off` sends only the final reply.

When COT is enabled, the bridge splits the process view and final answer into two messages. The COT message is for tracing what the agent did; the final answer is still generated from the agent's raw text, without heuristic bridge-side filtering. If an agent emits final-answer text as ordinary stream text, that text can also appear in the COT process message. Detailed mode may expose sensitive values present in tool arguments or output, so select `brief` or `off` for chats where that visibility is inappropriate.

## Channel tooling

Channel-specific tooling belongs to the channel that owns it, not to the core.
For the built-in Lark / Feishu channel that means the profile-local `lark-cli`
directory, `LARKSUITE_CLI_CONFIG_DIR`, and the `bot-only` / `user-default`
identity policy. See the [Lark / Feishu channel](docs/LARK_CHANNEL.md).

## Working directories

Each profile may define a default working directory through `workspaces.default`.
New profiles may be created with `--workspace <path>`; if omitted, the bridge
creates a profile-managed default working directory. Explicit user workspaces
are validated and recorded but are never scaffolded or rewritten.

This is a profile-field snippet. Do not replace the whole `config.json` with it; edit the matching profile's `workspaces` field.

```json
{
  "workspaces": {
    "default": "/Users/me/.aria-workspaces/claude/default"
  }
}
```

The bridge checks that a selected directory exists, is a directory, and is not an overly broad location such as `/`, the home root, a system directory, or a temp root. The working directory is only the current directory for an agent run. It is not a filesystem sandbox; actual file access still depends on the local agent process and its permission mode.

## Permission modes

The recommended user-facing profile config is `permissions.defaultAccess` and `permissions.maxAccess`. New profiles default to `full` for both values so the bridge can keep local tools, authorization flows, file writes, and other agent features fully usable. To tighten a profile, set one or both values to `workspace` or `read-only`; stricter modes can limit local tool execution, login/authorization flows, file writes, and similar capabilities.

This is a profile-field snippet. Do not replace the whole `config.json` with it; edit the matching profile's `permissions` field.

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

Mode mapping:

| Bridge access | Claude permission mode | Codex mode | OpenCode |
|---|---|---|---|
| `full` | `bypassPermissions` | `danger-full-access` | `--auto` |
| `workspace` | `acceptEdits` | `workspace-write` | no `--auto` |
| `read-only` | `plan` | `read-only` | no `--auto` |

OpenCode permission prompts cannot be answered in the bridge's headless environment and are denied outright, so only `full` enables auto-approval (`--auto`; explicit deny rules from OpenCode's own config still apply).

## Data directories

| Path | Content |
|---|---|
| `~/.aria/config.json` | Root config with profiles and active profile |
| `~/.aria/active-profile` | Last selected profile |
| `~/.aria/profiles/<profile>/sessions.json` | Session state |
| `~/.aria/profiles/<profile>/sessions.json.catalog.json` | Agent-aware session catalog |
| `~/.aria/profiles/<profile>/workspaces.json` | Current and named workspace bindings |
| `~/.aria/profiles/<profile>/secrets.enc` | Profile-local encrypted secrets |
| `~/.aria/profiles/<profile>/lark-cli/` | Profile-local lark-cli directory |
| `~/.aria/profiles/<profile>/media/` | Attachment cache |
| `~/.aria/profiles/<profile>/logs/` | Structured run logs |
| `~/.aria/registry/processes.json` | Local process registry |
| `~/.aria/registry/locks/` | Profile and app locks |

Set `ARIA_HOME=/path/to/state` and
`ARIA_WORKSPACE_HOME=/path/to/workspaces` to configure the two roots
independently. `LARK_CHANNEL_HOME` remains the compatibility state-root
variable used by existing bridge profiles. `LARK_CHANNEL_LOG_DAYS` overrides
log retention.

## Access control

**Chat access is private by default: out of the box, only *you* can use the bot in DMs and groups.** "You" = whoever created / owns the Feishu app (the person who scanned the QR to set it up). The bot figures out who the app owner is automatically from Feishu, so **solo chat use needs zero configuration** — you can DM it and `@`-mention it in any group, and everyone else's chat messages are silently ignored (no "permission denied" reply, which would only confirm the bot exists). Cloud-doc comments are document-scoped; see below.

To let other people or groups in, add them to one of three lists:

| List | Controls | Add | Remove |
|------|----------|-----|--------|
| **Allowed users** | who can DM the bot | `/invite user @them` | `/remove user @them` |
| **Allowed chats** | which groups the bot answers in (for **everyone** in them) | `/invite group` (current group) / `/invite all group` (every group the bot is in) | `/remove group` (current group) |
| **Admins** | who can change settings, and use the bot in any group | `/invite admin @them` | `/remove admin @them` |

> `/invite` and `/remove` can only be run by **you (the creator) and admins**. The `@` in the command points at the *target person* (not the bot) — the bot resolves the mention to their identity, so you never deal with raw IDs.

### Two identities that bypass everything

- **You (the creator)**: subject to no list at all — DMs, any group, every command. You **can never lock yourself out**: even if the lists get messed up, DM the bot and send `/config` to get back in. Transfer the app's ownership in the Feishu console and the bot follows the new owner automatically.
- **Admins**: can DM, run management commands like `/config`, and **bypass the allowed-chats list** — the bot answers them in any group, listed or not. Good for teammates who co-maintain the bot.

### Common setups

- **Just me** → nothing to do; this is the default.
- **Let a teammate DM the bot** → `/invite user @them`
- **Open a work group to everyone in it** → send `/invite group` inside that group
- **First-time setup, onboard every group the bot is already in** → `/invite all group` pulls them all into the list at once; trim with `/remove group` afterwards
- **Add a co-admin** → `/invite admin @them`

### Worth knowing

- Changes take effect on the **next message** — no restart needed.
- **Multi-person groups require `@bot` by default**; P2P and one-human/one-agent groups are addressed implicitly. `/config` can opt a group into ambient-message intake, but ambient messages never modify an active run.
- Strangers get pure silence — no reply at all. The one exception: if someone `@`-mentions the bot in a group that hasn't been opened up, the bot posts a friendly one-liner telling them an admin can run `/invite group` to enable it.
- Cloud-doc comments are document-scoped: anyone who can comment in a supported document and mention the bot can trigger a reply.

### Advanced: editing the config file directly

If you'd rather not do it inside Feishu, `/invite` and `/config` write the matching profile's `access` field in `~/.aria/config.json`. Empty lists mean nobody from that list, not open access. This is a profile-field snippet; do not replace the whole `config.json` with it:

```json
{
  "schemaVersion": 2,
  "profiles": {
    "claude": {
      "agentKind": "claude",
      "access": {
        "allowedUsers": ["ou_xxxxxxxxxxxxx"],
        "allowedChats": ["oc_xxxxxxxxxxxxx"],
        "admins": ["ou_xxxxxxxxxxxxx"],
        "requireMentionInGroup": true
      }
    }
  }
}
```

`allowedUsers` / `admins` take user `open_id`s; `allowedChats` takes group `chat_id`s. The easiest way to find an ID by hand: have the person message the bot (or `@` it in the group), then check the active profile's log:

```bash
grep '"event":"enter"' ~/.aria/profiles/<profile>/logs/bridge-$(date +%Y%m%d).jsonl | tail -5
```

Each line carries `chatId` (group / DM id) and `senderId` (user `open_id`). After a manual edit, **restart the bridge** or send `/reconnect` from an allowed admin context to apply it. For day-to-day tweaks `/invite` / `/config` are easier; direct edits are mainly for deployment scripts that pre-seed access.

## Channel-specific surfaces

Document comments, card actions, and other channel-owned surfaces are
documented with their channel. See the
[Lark / Feishu channel](docs/LARK_CHANNEL.md).

## FAQ

**The bot stays silent or the local CLI never replies.** Usually the selected local agent CLI is not installed or logged in, or the current session points to a working directory that no longer exists. Send `/status` to inspect; `/new` often fixes it by starting a fresh session.

**The agent subprocess looks frozen (card stuck on the last frame).** The bridge supports an idle watchdog: if the agent emits nothing for N minutes, the process is killed and the card is annotated with the auto-termination reason. Disabled by default. Enable with `/config` globally, or `/timeout 10` for the current session; `/timeout off` disables it for the session; `/timeout default` clears the session override.

**The agent says it cannot see an image I sent.** Upgrade to the latest version. Releases before 0.1.0 had a filename-dedup bug.

**`aria` is still the old command, or is not found after installation.** Check
`command -v aria` (or `Get-Command aria` in PowerShell), put the installer's
printed command directory before an older npm/pnpm global bin directory in
`PATH`, then open a new shell. The versioned installer preserves an adopted
legacy global command as a rollback baseline; it does not delete it.

<a id="documentation"></a>

## Documentation

| Need | Canonical document |
| --- | --- |
| Active-run follow-ups, group addressing, freshness, and duplicate suppression | [Conversation coordination](docs/COORDINATION.md) |
| Codex App Server, native steering, live status, and service tiers | [Codex App Server runtime](docs/CODEX_APP_SERVER.md) |
| Grok Agent stdio, ACP sessions, and direct steering | [Grok Agent stdio runtime](docs/GROK_AGENT_STDIO.md) |
| Built-in and external engine contracts | [Engine plugins](docs/PLUGINS.md) |
| Multi-channel plugins, lifecycle, isolation, and progressive delivery | [Channel platform architecture](docs/CHANNEL_PLATFORM_ARCHITECTURE.md) |
| Lark / Feishu channel, its tool identity policy, and document comments | [Lark / Feishu channel](docs/LARK_CHANNEL.md) |
| Stored channel instances and reversible schema v2→v3 migration | [Channel profile schema v3](docs/CHANNEL_SCHEMA_V3.md) |
| Versioned channel package/runtime contract and test kit | [Channel Plugin ABI v1](docs/CHANNEL_PLUGIN_ABI_V1.md) |
| Scheduled runs, reminders, future trigger sources, and result routing | [Trigger platform architecture](docs/TRIGGER_PLATFORM_ARCHITECTURE.md) |
| Private Release installation, update transactions, stable launcher, and rollback | [CLI distribution architecture](docs/DISTRIBUTION.md) |
| Profile state, managed workspaces, and engine-owned layout | [Workspace and state layout](docs/WORKSPACE_AND_STATE_LAYOUT.md) |
| Control-plane commands and extension boundary | [Control plane](docs/CONTROL_PLANE.md) |
| Contributor toolchain and required gates | [Toolchain](docs/TOOLCHAIN.md) |
| Versioning and release policy | [Release policy](docs/RELEASE_POLICY.md) |

### Full index

One document per topic, grouped by role.
[Documentation policy](docs/DOCUMENTATION_POLICY.md) defines the roles and the
status header every document carries.

**Current specifications** — describe what is true today.

[Agent Runtime architecture](docs/AGENT_RUNTIME_ARCHITECTURE.md) · [Channel platform architecture](docs/CHANNEL_PLATFORM_ARCHITECTURE.md) · [Channel Plugin ABI v1](docs/CHANNEL_PLUGIN_ABI_V1.md) · [Channel reliability primitives](docs/CHANNEL_RELIABILITY.md) · [Channel profile schema v3](docs/CHANNEL_SCHEMA_V3.md) · [Codex App Server runtime](docs/CODEX_APP_SERVER.md) · [Console development preview](docs/CONSOLE_DEVELOPMENT.md) · [Supervisor console behind a reverse proxy](docs/CONSOLE_REVERSE_PROXY.md) · [Management control plane](docs/CONTROL_PLANE.md) · [Conversation coordination](docs/COORDINATION.md) · [Deterministic scheduled actions](docs/DETERMINISTIC_SCHEDULED_ACTIONS.md) · [Aria CLI distribution architecture](docs/DISTRIBUTION.md) · [Documentation policy](docs/DOCUMENTATION_POLICY.md) · [Execution space architecture](docs/EXECUTION_SPACE_ARCHITECTURE.md) · [Grok Agent stdio runtime](docs/GROK_AGENT_STDIO.md) · [Lark / Feishu Channel](docs/LARK_CHANNEL.md) · [Lark CLI argument ownership](docs/LARK_CLI_ARGUMENT_POLICY.md) · [Native read API architecture](docs/NATIVE_READ_API.md) · [Aria Engine Plugins](docs/PLUGINS.md) · [Aria release policy](docs/RELEASE_POLICY.md) · [Business workspace provisioning](docs/SPACE_WORKSPACE_PROVISIONING.md) · [Aria toolchain](docs/TOOLCHAIN.md) · [Trigger platform architecture](docs/TRIGGER_PLATFORM_ARCHITECTURE.md) · [WeChat Customer Service Channel](docs/WECHAT_KF_CHANNEL.md) · [Workspace and state layout architecture](docs/WORKSPACE_AND_STATE_LAYOUT.md) · [Cooperative replies](docs/agent-cooperation.md) · [Aria bug ledger](docs/bug-ledger.md) · [Personal agent groups](docs/personal-agent-groups.md) · [Deployment public capabilities](docs/space-public-capabilities.md) · [Deployment-selected Space navigation](docs/space-workspaces.md) · [Team presentation and changing audiences](docs/team-presentation.md)

**Runbooks** — active work that still has open items.

[Channel platform delivery plan](docs/CHANNEL_PLATFORM_DELIVERY_PLAN.md) · [Space direct CLI plan](docs/SPACE_DIRECT_CLI_PLAN.md) · [Trigger Platform delivery handoff](docs/TRIGGER_PLATFORM_DELIVERY_HANDOFF.md)

**Historical records** — frozen; never edited to match later reality.

[Team completion delivery](docs/EXECUTION_SPACE_COMPLETION.md) · [Execution space delivery plan](docs/EXECUTION_SPACE_DELIVERY_PLAN.md) · [Execution space implementation through Phase 5](docs/EXECUTION_SPACE_IMPLEMENTATION.md) · [Execution space activation and migration](docs/EXECUTION_SPACE_PHASE6.md) · [Space Podman container and personal authorization plan](docs/space-linux-user-personal-auth-plan.md)

**Archived** — superseded, kept for provenance.

[CLI control-plane design](docs/CLI_CONTROL_PLANE_DESIGN.md) · [User Agent Space proposal](docs/USER_AGENT_SPACE_ARCHITECTURE.md)

## Testing and CI

Local checks:

```bash
corepack pnpm ci:local

# component gates for focused iteration
pnpm test
pnpm typecheck
pnpm build
```

`ci:local` is the complete pre-integration gate. `pnpm test` includes unit,
integration, and process-level adapter tests. CI runs on macOS, Ubuntu, and
Windows with a frozen install, tests, typecheck, and production build.

## Optional telemetry

By default the bridge reports **nothing**: no metrics, no logs leave your machine, and it pulls in zero telemetry dependencies. The hook below is inert unless you opt in.

To wire up your own monitoring, point an environment variable at a module that default-exports (or exports `createAdapter`) an `AdapterFactory`:

```bash
LARK_CHANNEL_TELEMETRY_MODULE=your-telemetry-package aria start
```

That module receives every `log.*` event plus error/metric hooks and forwards them wherever you like. The interface is exported from the package root:

```ts
import type { AdapterFactory, TelemetryAdapter, TelemetryEvent } from '@maxverse-ai/aria';

const createAdapter: AdapterFactory = (meta) => ({
  emit(event) {/* ship event */},
  recordError(err, ctx) {/* ship exception */},
  recordMetric(name, value, tags) {/* ship metric */},
  flush(timeoutMs) {/* drain buffered events */},
});
export default createAdapter;
```

A missing module, a bad factory, or a throwing adapter all degrade to noop — telemetry can never stop the bridge from starting or break logging.

## Project origin

Aria was forked from
[lark-channel-bridge](https://github.com/zarazhangrui/lark-coding-agent-bridge)
(MIT) and now evolves independently under
[maxverse-ai](https://github.com/maxverse-ai).

## License

[MIT](./LICENSE)
