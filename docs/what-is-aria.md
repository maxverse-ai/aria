# What is Aria

> Status: current

> 中文版：[what-is-aria.zh.md](what-is-aria.zh.md)

Aria is a **local-first control plane for coding agents. Chat is the remote
control, not the compute plane.**

Aria turns a chat surface into the interaction surface for coding agents that
run on your own machine. The engine, tools, files, and credentials stay local;
Aria owns message addressing, access control, profiles, sessions, workspaces,
streaming delivery, turn coordination, background services, and safe version
lifecycle operations.

The product contract is:

> Send an addressed task from chat, route it to the correct local agent and
> workspace, incorporate eligible follow-ups without losing queued input, and
> publish the terminal answer only while it is still fresh.

## What Aria owns vs. what stays local

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
```

- **Your machine keeps the compute.** Source trees, agent credentials, shell
  tools, and attachments stay on the host that runs Aria. Chat only steers.
- **Aria keeps the control plane.** Profiles isolate app credentials, agent
  state, workspaces, logs, and channel tool identity. Each chat, topic, or
  document-comment thread gets an independent session.
- **Engines stay pluggable.** Every engine plugin advertises its own history,
  image, service-tier, and live-input capabilities; Aria shows only the
  controls the selected engine and model actually support.
- **Follow-ups are never silently dropped.** An eligible message sent during a
  supported run can be merged into the running turn; anything the engine
  cannot accept stays owned by the next-turn queue.
- **Operations are recoverable.** Immutable release metadata, byte
  verification, stable launchers, detached updates, health checks, and
  transactional rollback keep a running bot recoverable.
- **Private by default.** The app owner is the only chat user initially;
  explicit user, group, and admin grants expand access — see
  [Secrets and access](secrets-and-access.md).

## Supported engines and channels

Built-in engine plugins (the `--agent <kind>` values): `claude` (Claude Code),
`codex` (Codex CLI), `grok` (Grok Build), `devin` (Devin), `opencode`
(OpenCode), `dsh` (DeepSeek Harness), `kimi` (Kimi Code), and `pi` (Pi). The
[engine plugin reference](PLUGINS.md) lists each engine's history, live-input,
and service-tier capabilities.

Lark / Feishu ships built in and is the production channel today — see the
[Lark / Feishu channel](LARK_CHANNEL.md). WeChat Customer Service
(`wechat-kf`) runs behind the same channel contracts — see the
[WeChat KF channel](WECHAT_KF_CHANNEL.md). External channel plugins use the
[Channel Plugin ABI](CHANNEL_PLUGIN_ABI_V1.md).

## The product boundary

- One local host owns execution; Aria is not a hosted multi-tenant agent
  cloud.
- Multi-person groups require a structured `@bot` mention for unambiguous
  addressing.
- Remote freshness history is bounded and fails open when unavailable or
  truncated, so a history failure never silently discards a terminal answer.
- Aria is distributed from private immutable GitHub Releases and is not
  published to npm.

## Where to go next

- [Quickstart](QUICKSTART.md) — install, first run, and the first agent
  session over chat.
- [Install and upgrade](install-and-upgrade.md) — update plans, rollback,
  service lifecycle, and uninstall.
- [Operate the bridge](operate-the-bridge.md) — foreground vs. daemon,
  profiles, process registry, and safe restarts.
- [Internals](AGENT_RUNTIME_ARCHITECTURE.md) — the engineering
  specifications behind these surfaces live in the Internals section of the
  sidebar.
