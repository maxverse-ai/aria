# Talk to your agent

> Status: current

> 中文版：[talk-to-your-agent.zh.md](talk-to-your-agent.zh.md)

How conversations reach the agent, what you can send mid-run, and the session
commands available in chat. This covers the Lark / Feishu channel, the
production channel today; WeChat KF has its own smaller command set documented
in the [WeChat KF channel](WECHAT_KF_CHANNEL.md).

## Addressing: when a message reaches the agent

| Conversation shape | Addressed to the agent |
| --- | --- |
| Direct message | Yes, implicitly |
| Group with exactly one human and the current bot | Yes, implicitly |
| Any other group or topic group | Only a structured `@bot` mention |

Replying to an agent message without `@` adds context but does not address the
bot, and ambient group messages are ignored by default. `@all` is ignored.
Cloud-doc comments in supported document types run when the bot is mentioned —
see the [Lark / Feishu channel](LARK_CHANNEL.md).

## Sending a task

Send plain language. The agent answers with a streaming card (or plain text,
depending on the profile's reply mode) plus an optional COT process message.
Useful session commands:

| Command | Effect |
| --- | --- |
| `/cd <path>` | Switch working directory and reset the session |
| `/new [task]`, `/reset` | Start a fresh session; optionally submit a new task |
| `/status` | Profile, agent, working directory, session, and run state |
| `/stop` | Stop the current run |
| `/model`, `/effort`, `/agent` | Inspect or switch model, reasoning effort, engine |
| `/resume` | Resume compatible history for the same agent and directory |
| `/ws list` · `/ws save <name>` · `/ws use <name>` · `/ws remove <name>` | Named workspaces |
| `/task <goal>` | Create a task and enter its task thread |
| `/help` | The full help card |

The complete slash-command table — access control (`/invite`, `/remove`),
`/config`, `/timeout`, `/goal`, `/loop`, `/remind`, `/meeting`, `/fast`,
`/doctor`, and more — is maintained in the
[README](../README.md#slash-commands-in-a-channel).

## Follow-ups while a run is active (steering)

You do not have to wait for a run to finish. An eligible addressed message
sent during a supported active run is offered to the engine; if the engine
cannot accept it, the message stays queued for the next turn — it is never
silently dropped. What the engine does with it depends on the engine's
live-input capability:

| Engine | Mid-turn text behavior |
| --- | --- |
| Codex CLI | Steered directly into the running turn (`turn/steer`) |
| Grok Build | Steered directly through Agent stdio |
| Devin | Steered when the ACP server advertises steer support; otherwise queued |
| Claude Code, Kimi, OpenCode, Pi, DeepSeek Harness, others | Queued and merged into the next turn |

Steering is currently text-only. Aria removes a message from the next-turn
queue only after the engine acknowledges it; deferred or rejected attempts
stay queued. Use `/new <task>` instead when the message should start a
separate task rather than join the running one. The mechanism matrix and the
mailbox fallback are specified in [Steering](STEERING.md); addressing and the
terminal-reply freshness check live in
[Conversation coordination](COORDINATION.md).

## Repetitive and long-running work

- **`/loop [--max <n>] <task>`** re-submits the same task as consecutive runs
  (default 10 iterations, capped at 100; admin only to start). A follow-up
  sent mid-iteration rides into the next round's prompt batch. `/loop status`,
  `/loop stop`.
- **`/goal [objective] [--budget <tokens>]`** sets a Codex session goal that
  keeps working across turns; `/goal resume`, `/goal pause`, `/goal clear`.
- **`/remind at <ISO time> <task>`** creates a session-anchored reminder;
  `list`, `snooze`, `update`, `cancel`, `history` manage it. For the
  deterministic trigger platform behind scheduled work, see
  [Scheduled actions](scheduled-actions.md).

## Who else can talk to it

Chat access is private by default: only the app owner can use the bot.
`/invite user @them` opens DMs, `/invite group` opens the current group,
`/invite admin @them` adds an administrator. Lists and bypass rules are
covered in [Secrets and access](secrets-and-access.md).
