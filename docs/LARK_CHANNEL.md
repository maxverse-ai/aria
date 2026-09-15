# Lark / Feishu Channel

## Purpose

Expose an Aria profile to Lark / Feishu as addressed conversation input. The
channel normalizes direct messages, groups, topics, document comments, mentions,
files, and card actions, and hands them to core-owned routing, policy, session,
and delivery handling.

Lark / Feishu ships built in and is the production channel today. It is one
channel behind the channel platform — WeChat Customer Service and external
channel plugins use the same core contracts — so nothing here belongs in the
product's identity.

## Boundary

```text
Lark / Feishu user
  -> event subscription
  -> signature and decrypt adapter
  -> normalized conversation input
  -> core routing, policy, session, and delivery

core routing, policy, session, and delivery
  -> outbound intent
  -> card and message projection
  -> Lark / Feishu API
```

The channel owns protocol translation and the Lark-specific presentation
surfaces. It does not own access policy, workspace validation, permission
ceilings, or agent execution.

## lark-cli identity policy

Each profile uses a profile-local lark-cli directory at
`~/.aria/profiles/<profile>/lark-cli`. The agent process receives
`LARKSUITE_CLI_CONFIG_DIR` for that directory, so personal authorization in one
profile is not shared with another profile.

The default policy is `bot-only`: lark-cli uses the app/bot identity and does
not access personal resources. When a user authorizes personal resources such as
calendar, mail, or drive, the current profile can switch to `user-default`,
which keeps app identity available and also allows the authorized user
identity. Owner/admin users can inspect or change this policy in `/config`;
`/status` shows the current summary as `lark-cli: app` or
`lark-cli: user-ready`.

## Document comments

Cloud-doc comments do not need a separate workspace binding or document
allowlist. In supported document comments, mention the bot and the bridge
replies in the same thread. Comment runs reuse the document session key and
fall back to the user home directory when no document cwd was previously
recorded. Document comments follow the document's own permission model, so
anyone who can comment and mention the bot in a supported document can trigger a
reply.
