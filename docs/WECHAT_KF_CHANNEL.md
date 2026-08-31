# WeChat Customer Service Channel

## Purpose

Expose an Aria profile, such as the ***REMOVED*** PM bot, to ordinary WeChat users through
the WeChat Customer Service API without coupling WeCom protocol details to agent
execution.

## Boundary

```text
WeChat user
  -> WeCom Customer Service
  -> TLS reverse proxy
  -> loopback /wechat-kf/callback
  -> signature + AES adapter
  -> durable notification inbox
  -> sync_msg processor + durable cursor
  -> durable customer-message inbox
  -> control lane or per-user normal lane
  -> wxkf text handler
  -> ConversationRuntime
  -> agent execution
  -> channel outbound renderer
  -> send_msg
```

The callback is only a notification. It does not contain the customer message.
The processor must call `sync_msg` and advance its cursor only after all messages
on the page have been accepted downstream.

## Ownership and failure semantics

- The TLS proxy owns public HTTPS and routes only the callback path.
- `WechatKfCallbackHandler` owns verification, decryption, and protocol replies.
- `FileWechatKfNotificationInbox` owns callback durability. A successful callback
  response is sent only after its atomic file is fsynced.
- `WechatKfNotificationProcessor` owns serial pulling and cursor advancement.
- The channel message sink owns `msgid` idempotency and normalization into Aria.
- `WechatKfDurableMessageSink` durably accepts pulled messages before the sync
  cursor advances. Deployments must call `recover()` during startup. Normal
  questions remain serial per customer; exact commands use a separate control
  lane so `/stop` and `/new` are not trapped behind a long agent run.
- `WechatKfTextHandler` owns the wxkf-only command table and onboarding text.
  Commands are intercepted before `ProfileConversationHost.runText()` and do
  not enter agent context. This does not register commands on the Lark channel.
- `ConversationRuntime` owns agent concurrency, policy, sessions, and shutdown.
- The outbound renderer owns final-answer collection, 2048-byte splitting, and
  delivery status. WeChat Customer Service does not support token streaming.

If message handling fails, the cursor and notification remain unchanged. This is
at-least-once delivery; downstream consumers must treat `msgid` as an idempotency
key. An empty page with `has_more=1` is not terminal. A non-advancing cursor is
treated as an upstream protocol error rather than an infinite loop.

## Security defaults

- The callback listener defaults to `127.0.0.1` and relies on the deployment's
  existing TLS reverse proxy.
- Token, EncodingAESKey, application Secret, access tokens, callback pull tokens,
  external user IDs, and plaintext messages must not be logged.
- Token and EncodingAESKey belong in the profile secret provider, never committed
  configuration.
- External user IDs are HMAC-derived before they become Aria actor/scope IDs.
- Inbox and cursor files are written with mode `0600`.
- Only `origin=3` customer messages may enter the agent. `origin=5` staff replies
  must be ignored to prevent feedback loops; `origin=4` events use a separate
  event path.

## Deployment composition still required

The protocol package deliberately does not start itself from the core daemon.
The profile composition layer must provide:

1. secret resolution for CorpID, Secret, Token, EncodingAESKey, and session HMAC;
2. access-token caching and refresh;
3. a customer-text message sink bound to the selected Aria profile;
4. a final-answer renderer using `send_msg`;
5. channel runtime lifecycle (start, readiness, drain, close, retry/backoff);
6. an Nginx route from the public domain to the loopback listener.

This keeps WeChat Customer Service removable and permits future channel packages
to reuse the same conversation runtime without importing WeCom code.

## Customer commands and onboarding

The public wxkf command set is intentionally small:

- `/help` (`help`, `帮助`) renders the wxkf help text locally;
- `/new` (`/reset`) archives resumable state and forces the next turn to start a
  new engine session without deleting native history;
- `/stop` (`/cancel`) interrupts the active run for the same anonymized scope;
- any other slash-prefixed input is rejected locally with a `/help` hint.

Only a whole-message, case-insensitive match is a command. Command definitions,
aliases, help text, and tests come from `src/channel/wechat-kf/commands.ts`; they
must not be copied into an agent prompt or `AGENTS.md`.

The first ordinary customer question receives one short welcome before the
question continues normally. A successful first `/help` substitutes for that
welcome. Onboarding state is independent from session reset state and stores
only the HMAC-derived actor ID. A failed welcome never blocks the question and
is retried on a later ordinary message.
