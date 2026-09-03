# Channel profile schema v3

Status: implemented as an explicit opt-in migration. Schema v2 remains the
fresh-install default until deployment evidence authorizes a separate default
cutover.

## Purpose and ownership

Schema v3 gives Aria core one stored, versioned source for channel packages and
configured channel instances. It does not load external code, log in to a
provider, or move provider message, cursor, delivery, or session state.

The stable runtime key remains `(profileId, pluginId, instanceId)`. Engine
packages continue to use the existing profile `plugins` field. Channel packages
live only in `channels.plugins`; the two namespaces are never inferred from one
another.

## Stored shape

```json
{
  "schemaVersion": 3,
  "profiles": {
    "primary": {
      "schemaVersion": 3,
      "plugins": ["engine-package"],
      "channels": {
        "plugins": [
          {
            "package": "@scope/aria-channel-example",
            "version": "1.2.3"
          }
        ],
        "instances": {
          "lark-primary": {
            "plugin": "lark",
            "enabled": true,
            "configVersion": 1,
            "config": {
              "appId": "cli_example",
              "tenant": "feishu",
              "credentialMode": "secret-ref"
            },
            "secretRefs": {
              "appSecret": {
                "source": "env",
                "id": "LARK_APP_SECRET"
              }
            }
          }
        }
      }
    }
  }
}
```

Package versions are exact semver values. Instance ids and plugin ids use the
Channel ABI validators. Public config contains JSON values only. Credentials
inside `channels` must be `SecretRef` records; inline channel secrets are
rejected.

`wechat-kf` and `weixin-ilink` are always separate canonical plugin ids and
instances. Migration from schema v2 creates only the existing authoritative
`lark` / `lark-primary` record. It never guesses that an externally composed
Customer Service or personal WeChat account exists.

## Compatibility window

Aria reads and writes both schema v2 and v3. Reads do not rewrite bytes. A root
and every profile below it must use the same schema version.
Profiles created inside an existing v3 root are projected to v3 before commit,
and profile exports preserve the selected profile's schema version.

During Stage 8, the proven Lark transport still reads its credential binding
from the compatibility `accounts.app` field. A schema-v3 `lark-primary` record
must describe that exact same app id, tenant, credential mode, and config
version, including the projected secret reference, or startup fails closed.
Later Management API work can remove this
temporary dual representation through another reviewed migration.

Other schema-v3 channel instances are resolved and validated but are not loaded
as external packages in this stage. External package trust and lifecycle begin
only in Stage 9.

## Migration transaction

The public migration API is deliberately separate from ordinary config reads:

1. `planChannelSchemaV3Migration()` reads and validates schema v2, computes a
   source revision, and returns a secret-free plan without writing anything.
2. `applyChannelSchemaV3Migration()` locks the config, rejects source drift,
   writes an exact private backup (`0600` on POSIX), atomically writes schema v3, then reloads
   and validates the result.
3. If write verification fails, apply restores the exact source bytes. An
   identical backup left by interruption is safely reused; a different backup
   is never overwritten.
4. `rollbackChannelSchemaV3Migration()` optionally checks the current revision,
   restores the exact schema-v2 backup atomically, and validates it. If rollback
   validation fails, it restores the previous schema-v3 bytes.

The plan contains paths, revisions, profile ids, and resulting instance ids; it
never contains configuration or credential values.

## Rollback boundary

Schema rollback changes only `config.json`. Channel message stores, provider
cursors, reliability receipts, engine sessions, and workspaces are outside this
transaction and remain untouched. Operators must still drain a live profile
before applying or rolling back stored desired state.
