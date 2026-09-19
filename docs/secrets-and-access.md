# Secrets and access

> Status: current

> 中文版：[secrets-and-access.zh.md](secrets-and-access.zh.md)

Where Aria keeps credentials and who can talk to your bot.

## The encrypted keystore

Each profile has an encrypted secret keystore at
`~/.aria/profiles/<profile>/secrets.enc` (under `$ARIA_HOME` when set). It
holds channel app secrets — for example the App Secret of the bound
PersonalAgent app.

```bash
aria secrets set --app-id cli_xxx [--profile <name>]   # prompts without echoing
aria secrets list [--profile <name>]                   # ids only, never values
aria secrets remove --app-id cli_xxx --yes [--profile <name>]
```

`aria secrets get` is the machine side of the same keystore: it reads a JSON
request on stdin and writes decrypted values on stdout — the exec-provider
protocol that `lark-cli config bind --source lark-channel` uses to resolve
app secrets without storing them in its own config. Humans normally do not
need it.

Related surfaces:

- `aria profile export <name>` redacts secret-provider configuration and app
  secret values by default; `--include-secrets --yes` exports them for a
  deliberate migration.
- `/account` in chat shows the bound app; `/account change` replaces its
  appId/secret and reconnects, storing the plaintext only in the profile
  keystore.
- The profile-local **lark-cli identity policy** (`bot-only` vs.
  `user-default`) controls whether lark-cli can act with a personal user
  identity — see the [Lark / Feishu channel](LARK_CHANNEL.md).

## Access control: private by default

Out of the box, only **you** — the Feishu/Lark app owner — can use the bot, in
DMs and any group. Everyone else's messages are silently ignored; the owner
can never be locked out. Three lists open access up, all managed in chat:

| List | Controls | Add | Remove |
| --- | --- | --- | --- |
| Allowed users | who can DM the bot | `/invite user @them` | `/remove user @them` |
| Allowed chats | which groups the bot answers in (for everyone in them) | `/invite group` · `/invite all group` | `/remove group` |
| Admins | who can change settings and use the bot in any group | `/invite admin @them` | `/remove admin @them` |

Changes take effect on the next message — no restart. The full semantics
(creator/admin bypass, silent-stranger behavior, per-chat mention overrides,
and the raw `access` config fields for deployment scripts) are in the
[README access-control section](../README.md#access-control).

## Permission modes

`permissions.defaultAccess` and `permissions.maxAccess` bound what the local
agent may do: `full` (default for new profiles), `workspace`, or `read-only`.
The engine-mode mapping and per-engine caveats live in the
[README permission-modes section](../README.md#permission-modes). Edit the
matching profile's `permissions` field in `~/.aria/config.json` — do not
replace the whole file — then restart the bridge or send `/reconnect`.

## Telemetry: off unless you wire it

The bridge reports nothing by default — no metrics or logs leave the machine.
Opting in means pointing `LARK_CHANNEL_TELEMETRY_MODULE` at your own adapter
module; a missing or throwing adapter degrades to a no-op rather than breaking
the bridge. The adapter contract is in the
[README telemetry section](../README.md#optional-telemetry).
