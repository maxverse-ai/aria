# Codex App Server runtime

> Status: current

Aria's Codex engine uses one managed `codex app-server --stdio` process per
profile. The App Server is the only supported Codex execution transport.
Its runtime descriptor advertises `profile-daemon` topology and only the
semantic capabilities Aria currently wires; App Server method names remain
private to the Codex runtime.

The earlier user-specific App Server proposal is archived and was never
implemented. It is retained only as historical context in
[`USER_AGENT_SPACE_ARCHITECTURE.md`](USER_AGENT_SPACE_ARCHITECTURE.md); the
active architecture remains one engine runtime per profile.

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

## Active-turn follow-ups

Codex advertises a structured, text-only live-input capability. Aria
automatically sends an eligible, addressed follow-up through `turn/steer` with
the active `threadId`, an `expectedTurnId`, and the new text envelope. There is
no user-facing mode or profile switch. The message leaves the next-turn inbox
only after App Server returns that same turn id. Duplicate Feishu deliveries
reuse a stable request id and do not send the JSON-RPC call twice. Any
deferred/rejected attempt retains the message for the next turn. See
[`COORDINATION.md`](COORDINATION.md) for addressing, ownership, and final-reply
ordering.

## Live status

`/status` reads structured metadata from
`account/read` and `model/list`, plus `account/rateLimits/read` when the account
is a ChatGPT login — the rate-limit endpoint only exists for that account type,
so API key and Bedrock profiles skip it and show no limit windows. The card
displays the model, plan, context usage, and remaining limit windows. Account
email is intentionally not rendered in chat.

## Service tiers and Fast mode

Service tiers are modeled as an optional engine/model capability, not as a
global `AgentCapability.fast` flag. Codex discovers tier ids from `model/list`
(`serviceTiers`) and currently exposes the `fast` tier through `/fast` and the
Feishu `/config` card. Engines and models that do not declare service tiers do
not render the control.

The profile preference has three intentional states:

- property absent: inherit the Codex configuration;
- `null`: explicitly use the standard tier (`Fast off`);
- a string such as `"fast"`: request that engine-native tier.

Aria sends the resolved value on `thread/start`, `thread/resume`, and
`turn/start`. A named tier not declared by the selected model is standardized
instead of being sent as an invalid request. The run status line is projected
from `ThreadStartResponse.serviceTier` / `ThreadResumeResponse.serviceTier`, so
it shows the tier the App Server actually accepted rather than the saved
preference. Older App Server versions that omit the field simply omit this
status item.

## Protocol compatibility

The local Codex binary is the protocol authority. The implementation targets
the bindings produced by:

```sh
codex app-server generate-ts --experimental --out <temporary-directory>
```

Protocol parsing is deliberately narrow and tolerant of unknown notifications.
Upgrade Codex in a test profile first and run the App Server process tests before
rolling it out to a live profile.
