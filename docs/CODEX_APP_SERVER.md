# Codex App Server runtime

Aria's Codex engine uses one managed `codex app-server --stdio` process per
profile. The App Server is the only supported Codex execution transport.

The proposed, not-yet-implemented design for keeping group traffic on a shared
bot runtime while giving each direct-message user an isolated App Server is
documented in [`USER_AGENT_SPACE_ARCHITECTURE.md`](USER_AGENT_SPACE_ARCHITECTURE.md).

Profiles only need to identify the Codex binary:

```json
{
  "codex": {
    "binaryPath": "/absolute/path/to/codex"
  }
}
```

## Lifecycle and permissions

The profile owns the App Server process. Aria closes it on failed startup,
profile restart, engine switch, shutdown, and failed replacement. All turns use
the profile's configured sandbox. Approval policy remains `never`; App Server
does not grant a broader sandbox.

App Server requests that require interactive approval are declined. Other
unsupported server-initiated requests fail explicitly instead of hanging.

## Live status

`/status` reads structured metadata from
`account/read`, `account/rateLimits/read`, and `model/list`. The card displays
the model, plan, context usage, and remaining limit windows. Account email is
intentionally not rendered in chat.

## Protocol compatibility

The local Codex binary is the protocol authority. The implementation targets
the bindings produced by:

```sh
codex app-server generate-ts --experimental --out <temporary-directory>
```

Protocol parsing is deliberately narrow and tolerant of unknown notifications.
Upgrade Codex in a test profile first and run the App Server process tests before
rolling it out to a live profile.
