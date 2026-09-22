# Quickstart

> Status: current

> 中文版：[QUICKSTART.zh.md](QUICKSTART.zh.md)

Aria is a local-first control plane for coding agents: chat is the remote
control, not the compute plane. The engine, tools, files, and credentials stay
on your own machine; Aria owns message addressing, access control, profiles,
sessions, workspaces, streaming delivery, and safe version lifecycle. This
guide walks from a clean machine to a working agent session over chat.

## 1. Prerequisites

- Node.js `>=24.0.0` — the floor declared in `package.json#engines.node`;
  `.node-version` pins the CI runtime.
- At least one local agent CLI installed and logged in: Claude Code
  (`claude`), Codex CLI (`codex`), Grok Build (`grok`), OpenCode (`opencode`),
  Devin (`devin`), DeepSeek Harness (`dsh`), Kimi Code (`kimi`),
  MiMo Code (`mimo`), or Pi (`pi`).
- A Feishu / Lark **PersonalAgent** app — or let the first-run QR wizard
  create and bind one for you.
- The GitHub CLI (`gh`) authenticated with an account that can read
  `maxverse-ai/aria`. Aria is distributed from private immutable GitHub
  Releases and is not published to npm.

## 2. Install

Linux / macOS:

```bash
gh auth status
ARIA_REPOSITORY=maxverse-ai/aria
ARIA_TAG="$(gh api "repos/$ARIA_REPOSITORY/releases?per_page=100" --jq 'map(select(.draft == false and .prerelease == true and .immutable == true and (.tag_name | startswith("internal-v")))) | sort_by(.tag_name | ltrimstr("internal-v") | split(".") | map(tonumber)) | last.tag_name')"
ARIA_INSTALL_TMP="$(mktemp -d)"
gh release download "$ARIA_TAG" --repo "$ARIA_REPOSITORY" --pattern aria-install.mjs --dir "$ARIA_INSTALL_TMP"
node "$ARIA_INSTALL_TMP/aria-install.mjs"
```

On Windows, run the same flow in PowerShell; the exact variant is maintained
in the [README](../README.md#install). To pin an exact immutable release, add
`--version <x.y.z>` to the installer command.

The installer delegates credentials to `gh` — Aria never reads or stores a
GitHub token — installs versioned packages under a platform data directory,
and writes a stable `aria` launcher (normally `~/.local/bin/aria` on Linux and
macOS). Add the printed command directory to `PATH` if needed, then verify:

```bash
command -v aria
aria --version
```

For the update, rollback, and install-state contract, see the
[CLI distribution architecture](DISTRIBUTION.md).

## 3. First run — connect the chat channel

```bash
aria run
```

The first run opens a QR-code wizard:

1. A QR code renders in your terminal.
2. Scan it with the Feishu / Lark app.
3. Pick or create a PersonalAgent app.
4. If prompted, choose which agent to initialize.
5. Config is written to `~/.aria/config.json`.

Binding the PersonalAgent app is what connects the chat channel: Lark /
Feishu ships built in and is the production channel today (see the
[Lark / Feishu channel](LARK_CHANNEL.md)). To use an existing app instead of
creating one, pass `--app-id` and enter the App Secret when prompted:

```bash
aria run --app-id cli_xxx
```

For Lark global apps, add `--tenant lark`.

You do not need to pick a project directory up front. The bridge creates a
profile-managed default working directory with an identity-neutral
`AGENTS.md`, `README.md`, and `scratch/`; after startup, send `/cd <path>` in
chat to switch to a real project.

## 4. First agent session

Open a direct message with the bot in Feishu / Lark. The app owner is the only
chat user initially, and DMs are addressed implicitly, so plain text already
reaches the agent.

1. Send `/cd <path>` to switch the session to your project directory.
2. Send a task in plain language and watch the streaming card reply.
3. Useful session commands: `/status` (profile, agent, session, and run
   state), `/new` (fresh session), `/stop` (stop the current run), `/model`
   and `/agent` (inspect or switch the model and engine).

During a supported active run, an eligible addressed follow-up is merged into
the running turn or safely kept for the next one — it is never silently
dropped. In groups, address the agent with a structured `@bot` mention; the
full addressing and follow-up rules live in
[Conversation coordination](COORDINATION.md).

## 5. Run it in the background

`aria run` is for first-run setup and foreground debugging. Once the bot
answers in chat, stop it with `Ctrl-C` and use the OS-managed service:

```bash
aria start
aria status
aria stop
```

The service definition points at the stable launcher, so upgrades and
rollbacks keep it valid. Daemon logs live under
`~/.aria/profiles/<profile>/logs/daemon/`. `aria ui` opens the local web
console for config, profiles, and online bots.

## Where to go next

- [Talk to your agent](talk-to-your-agent.md) — addressing, session commands,
  and mid-turn follow-ups.
- [Operate the bridge](operate-the-bridge.md) — daemon, profiles, process
  registry, and safe config changes.
- [Install and upgrade](install-and-upgrade.md) — `aria update`, rollback,
  and uninstall.
- [Troubleshooting](troubleshooting.md) — when the bot stays silent or the
  run looks frozen.
- [CLI reference](CLI_REFERENCE.md) — every command and flag, auto-derived
  from the CLI source.
- [Lark / Feishu channel](LARK_CHANNEL.md) — channel boundary, lark-cli
  identity policy, and document comments.
