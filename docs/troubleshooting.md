# Troubleshooting

> Status: current

> 中文版：[troubleshooting.zh.md](troubleshooting.zh.md)

The fast checks first, then where to look. Commands referenced here are in the
[CLI reference](CLI_REFERENCE.md).

## First-response checklist

```bash
aria status          # is the OS daemon up? pid, last exit, log paths
aria ps              # which bridge processes are registered/alive
aria inspect         # last 24h: messages, runs, failures, queue waits
aria preflight restart   # is a restart safe right now? (0 safe / 2 blocked / 3 unavailable)
```

In chat, `/status` shows the profile, agent, working directory, session, and
run state; `/doctor [description]` runs low-sensitive diagnostics.

## The bot stays silent or the agent never replies

Usually one of:

1. **The local agent CLI is not installed or logged in.** Check the CLI for
   the profile's `agentKind` directly on the host.
2. **The session points at a working directory that no longer exists.** Send
   `/cd <path>` or `/new` to reset the session.
3. **The message was never addressed to the bot.** In multi-person groups only
   a structured `@bot` mention addresses the agent — see
   [Talk to your agent](talk-to-your-agent.md).
4. **Access lists exclude the sender.** Strangers get silence by design; check
   `/status` and the access lists in
   [Secrets and access](secrets-and-access.md).

## The agent subprocess looks frozen

The card sticks on the last frame when the agent emits nothing. Enable the
idle watchdog: `/timeout 10` kills a run silent for 10 minutes and annotates
the card with the auto-termination reason; `/config` sets a global default;
`/timeout off` disables it for the session; `/timeout default` clears the
session override.

If the bridge process itself is wedged, `aria ps` then `aria kill <id|#>` —
but for a service-managed daemon use `aria restart` instead (`kill` refuses
service-owned pids because the service manager would respawn them).

## `aria` is the old command, or not found after install

```bash
command -v aria      # PowerShell: Get-Command aria
aria --version
```

Put the installer's printed command directory ahead of any older npm/pnpm
global bin directory in `PATH`, then open a new shell. The installer preserves
an adopted legacy global command as a rollback baseline — it does not delete
it.

## A restart or update fails safety checks

- `aria restart` refuses while active work is detected; run
  `aria preflight restart` for the evidence and retry later, or accept the
  risk with `--force`.
- `aria update apply` rechecks live activity, release metadata, and package
  bytes; a failed health check restores the previous version and service
  definitions automatically. `aria update status` reads the journaled
  operation; `aria update rollback` switches back explicitly.

## Where the logs live

| Path | Content |
| --- | --- |
| `~/.aria/profiles/<profile>/logs/` | structured run logs (`bridge-YYYYMMDD.jsonl`) |
| `~/.aria/profiles/<profile>/logs/daemon/` | OS-daemon stdout/stderr |
| `~/.aria/registry/processes.json` | the process registry behind `aria ps` |

`LARK_CHANNEL_LOG_DAYS` overrides log retention. `aria inspect --hours <n>`
summarizes the run logs without opening them.

## Images, follow-ups, and "the agent can't see my image"

- The agent says it cannot see an image you sent: upgrade — releases before
  0.1.0 had a filename-dedup bug (`aria update check`).
- A follow-up you sent mid-run had no effect: it may have been queued rather
  than steered. Only some engines accept mid-turn input — see the per-engine
  table in [Talk to your agent](talk-to-your-agent.md). Nothing is lost: the
  message is merged into the next turn.

## Still stuck

Collect `aria inspect --json`, the daemon log tail, and `/doctor` output
before reporting — they carry no credentials.
