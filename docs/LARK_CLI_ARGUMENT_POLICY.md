# Lark CLI argument ownership

> Status: current

Aria selects the authorized space, account, credential slot and effective
identity. The CLI defines business arguments; Feishu decides API scopes and
resource access. An adapter must not infer credential mutation from words such
as `token`, `config`, `app-id` or `source`.

The command contract below was checked against lark-cli 1.0.89. It is shared by
the native entry and the host credential provider in
`src/lark-cli/argument-policy.ts`.

## Incidents that motivated the change

On 2026-09-08 a successful bot document read was followed by a rejected
`docs +media-download --type whiteboard --token <board-id>`. The old adapter
treated every `--token` as an attempt to replace credentials. The request never
reached Feishu. `drive +export --token <document-id>` failed for the same reason.

A separate file-upload request stopped at command discovery: the provider
rewrote `lark-cli --help` into `lark-cli --help --as bot`, producing
`unknown command "bot" for "lark-cli"`. No upload or folder-permission check had
yet occurred. `skills read` was also classified as configuration management,
although this CLI embeds read-only skill content.

These errors are not evidence of missing resource permissions. Redirecting the
user to OAuth cannot repair an adapter argument error. A deployment that
disables user authorization will also reject OAuth in a private chat.

## Minimal boundary

| Operation / argument | Owner and behavior |
| --- | --- |
| Resource tokens, Miaoda app IDs, business JSON/configuration, other service options | Forward to the selected CLI command; no credential-keyword blacklist and no resource-ID validation in Aria. |
| `--as bot` / `--as user` | Extract once from options, then resolve through the current space's credential grants. The provider rejects caller identity selectors and injects its verified identity. |
| `--profile` | Reject: this is the CLI's actual global selector for a different configuration/binding. |
| `config`, `profile`, `update` and host diagnostics | Use the owned management entry, not a business-tool invocation. |
| `auth login/logout/status`, `whoami` | Use Aria's scoped authorization/status adapter. Raw provider calls cannot manage authorization. |
| `--help`, `help …`, `--version`, `schema`, `skills list/read`, `event list/schema` | Read embedded metadata with the host-owned environment, without an identity flag, OAuth verification or a new credential binding. |
| `event consume` | A business operation with the selected identity and the existing host deadline/cancellation limits. Event daemon management remains owned. |
| Other declared business domains, shortcuts and raw APIs | Preserve CLI validation, exit code and output. Aria does not duplicate business schemas, API paths, scopes or write-risk rules. |

Business invocations still verify the provider app and effective identity, keep
the credential reference private, confine the caller's working directory, and
use the existing operation/space/actor fences. A deployment with user
authorization disabled always selects bot for automatic calls and rejects an
explicit user identity. When enabled, a user identity must have the current
principal's valid grant. There is no fallback to another account or ambient
profile.

Reading embedded metadata still requires the original authorized operation and
space. Skipping credential verification for metadata does not repair, rebind or
hide a broken business credential binding. The next business call verifies that
binding normally.

## Parse options, not payload substrings

Known string-valued fields consume their operands. For example, a message body
equal to `--profile` or `--as` is text, not a selector. These fields are normalized
to `--name=value`, so validation at the provider cannot reinterpret their values.
JSON contents are never searched for management words. Other CLI options are
forwarded without an allowlist.

Use `--option=value` for an unfamiliar option whose value itself starts with a
dash. Without the CLI's complete flag schema, Aria must not guess whether an
unknown flag is a boolean or takes a value. The common string-field vocabulary
is an operand parser, not an authorization allowlist.

The `--` end-of-options marker is respected. Aria inserts the verified identity
before that marker; positional text after it cannot select a different profile
or identity. Help requests are constructed as actual help operations instead
of forwarding a management command with an appended help flag.

## Failure ownership and recovery

| Failure | Meaning | Correct next step |
| --- | --- | --- |
| `[lark-cli:invalid-arguments]` | Aria cannot parse the transport/identity options. | Correct the command; do not request OAuth. |
| `[lark-cli:management-required]` | A command tries to select a profile or enter an owned management operation. | Report the actual boundary and use its management workflow when authorized. |
| `[lark-cli:unsupported-command]` | The CLI operation has not been classified by this adapter. | Check the installed CLI contract; classify the operation, not individual resource IDs. |
| Deployment identity policy | User identity/authorization is disabled. | Use bot; changing chat type does not change deployment policy. |
| Binding unavailable / identity mismatch | The selected credential slot is broken or belongs to another principal/app. | Stop; inspect bridge/doctor/preflight. Never switch profiles or rebind to bypass it. |
| CLI validation error | The CLI rejected an option or command. | Inspect help/schema; it is not a Feishu resource-permission decision. |
| Feishu API scope/resource denial | A real request reached the provider. | Check that app's scopes and the resource's sharing/authorization. |

The tool description exposes the deployment authorization policy in advance.
Local argument errors include their owner and explicitly say that no Feishu
request was made. They do not echo credential values. Existing provider failure
codes and the no-retry behavior for external writes remain intact.

## Compatibility checks

The 2026-09-09 first-use incident exposed a filesystem side effect of embedded
help: the real CLI creates `cli/cache` even without binding. Inspection now uses
an `inspection` subtree within the same host-owned space slot, separate from
the business CLI directory. A legacy slot containing only an empty `cli/cache`
(and optionally its inspection directory) is uninitialized and may complete
the normal owned first bind. Configured, nonempty, symlinked or unknown state
is never erased or rebound. This recovers affected existing spaces without
moving their histories, files or identity. Regression coverage includes help
before first business use, concurrent first calls, and rejected partial state;
***REMOVED*** acceptance additionally exercises real CLI help/bind with synthetic
credentials and no provider HTTP requests, including provider reconstruction.

When upgrading the CLI, check root management commands, global configuration
selectors, embedded inspection commands and identity support. Extend the
operation classification if the CLI introduces a new domain or management
entry. Do not add a blanket ban on a business option name.

Regression coverage includes the observed media-download, document-export and
root-help commands; embedded skills/schema; business IDs and JSON; literal
option-looking text; both forms of identity options; `--`; profile switching;
bot-only policy; and the existing concurrent-principal, binding-fault,
revocation, private-chat and later-request OAuth tests. These checks establish
adapter behavior; they do not claim that every target resource is shared with
the bot or that every Feishu API supports bot identity.
