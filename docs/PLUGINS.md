# Aria Engine Plugins

> Status: current

> 中文版：[PLUGINS.zh.md](PLUGINS.zh.md)

Aria drives local coding-agent CLIs through a plugin registry. Eight engines ship
in the current build:

| Id | Display name | Native history | Native live text | Service tiers |
| --- | --- | --- | --- | --- |
| `claude` | Claude Code | Yes | No | No |
| `codex` | Codex CLI | Aria reads Codex thread history | Yes, App Server `turn/steer` | Yes, model-scoped |
| `grok` | Grok Build | Yes, ACP session list | Yes, Agent stdio interject | No |
| `devin` | Devin | Yes, ACP session list | Conditional, ACP `session/inject` steer | No |
| `opencode` | OpenCode | Yes | No | No |
| `dsh` | DeepSeek Harness | No | No | No |
| `kimi` | Kimi Code | Yes | No | No |
| `pi` | Pi | Yes | No | No |

External engines can be loaded dynamically from an installed ES-module package
(registry, workspace, or local package). The core channel, profile,
coordination, and distribution layers do not need a new engine-specific branch.

## Contract

An engine plugin is an ES module that default-exports (or named-exports)
`enginePlugin`:

```ts
import { defineEngineRuntimeDescriptor } from '@maxverse-ai/aria';

export const enginePlugin: EnginePlugin = {
  id: 'acme',                         // globally unique engine id
  displayName: 'Acme Agent',
  sessionKind: 'acme-session',        // opaque identity interpreted by the plugin
  supportsNativeHistory: true,
  probes: [{ command: 'acme-agent', envKey: 'ARIA_ACME_BIN' }],
  defaultBinary: 'acme-agent',
  defaultBinaryEnvKey: 'ARIA_ACME_BIN',
  capability: (profile) => ({ ... }),
  createRuntime: (ctx) => ({
    engineId: 'acme',
    descriptor: defineEngineRuntimeDescriptor({
      engineId: 'acme',
      topology: 'one-shot',
    }),
    execution: new AcmeAdapter({
      binary: process.env.ARIA_ACME_BIN ?? 'acme-agent',
      profileDir: ctx.appPaths.profileDir,
    }),
    async dispose() { /* release processes, sockets and subscriptions */ },
  }),
  listHistory: async ({ cwd, limit, profileConfig }) => [...],
  modelLister: async ({ profileConfig }) => [...],
  effortFlag: (value) => ['--reasoning-effort', value],
  statusPermission: (profile) => ({ label: 'sandbox', value: '...' }),
  modelOptions: () => [...],
};
```

The full interface lives in `src/agent/plugin/types.ts`.

## Capability boundary

`EnginePlugin.capability(profile)` is the static advertisement used by the
channel and policy layers. It owns bridge prompt, callback, session identity,
and access-policy concerns. Optional channel behavior must be declared instead
of being inferred from an engine id:

- `steering` advertises acknowledged live input; the concrete execution object
  must also implement `steer(request)` and own delivery/idempotency;
- `supportsServiceTiers` permits model-scoped tier controls, while the live
  model catalog remains authoritative for which values are valid;
- `supportsImages` permits image attachments to enter the run;
- `supportsNativeHistory`, `listHistory`, and `sessionKind` define resume
  discovery without exposing engine storage to consumers;
- `permissions.maxAccess` caps the shared run policy before adapter-specific
  flags are generated.

An omitted capability is a supported fallback, not an error. For example,
engines without `steering` leave addressed follow-ups in the next-turn inbox,
and engines without service tiers do not render Fast controls or run-status
items. Send-time freshness remains a channel/coordinator responsibility for
every engine and is not a steering feature.

`EngineRuntime.descriptor` is the separate live-execution contract. It declares
process topology and semantic engine features without exposing native protocol
method names. One-shot adapters can use `createAdapterRuntime`, whose descriptor
is deliberately conservative. Native runtimes should use
`defineEngineRuntimeDescriptor` and declare only features backed by protocol
tests. Dynamic plugin descriptors are validated when the runtime is created.
Already-compiled plugins that omit the version-1 descriptor receive a
conservative `one-shot` descriptor for compatibility; new plugin source must
declare it explicitly.

Every execution receives a required, opaque `AgentRunOptions.scopeId`. It may
be used as a session-worker key but must not be parsed as a Feishu identifier.
See [`AGENT_RUNTIME_ARCHITECTURE.md`](AGENT_RUNTIME_ARCHITECTURE.md) for the
layer boundaries, lifecycle ownership, and native-runtime migration order.

## Loading

Add the package to a profile:

```json
{
  "agentKind": "acme",
  "plugins": ["@your-org/aria-engine-acme"]
}
```

The supervisor imports the package at profile start, validates the manifest,
and registers it. `/agent` then lists the engine automatically; `/agent use
<id>` switches to it at runtime (in-process profile restart).

The current core profile schema preserves built-in engine config fields only.
An external plugin should take simple binary/config overrides from its own
environment variables and keep namespaced state under the supplied
`profileDir`; it must not depend on arbitrary top-level profile keys surviving
normalization. A future extension-config schema belongs at this boundary rather
than as more built-in fields.

## Trust boundary

External plugins run **in-process** with the same privileges as the bridge.
Only install plugins you trust; pin exact versions.

## Lifecycle

- `loadExternalEnginePlugins(names)` — dynamic import + validation + register
- `createEngineRuntime(id, ctx)` — create a profile-owned execution runtime
- `runtime.descriptor` — versioned topology and semantic runtime capabilities
- `runtime.dispose()` — release engine resources on stop, restart, switch, or failed startup
- `unloadEnginePlugin(id)` — remove an inactive dynamically loaded plugin
- `onEnginePluginEvent(listener)` — subscribe to `loaded` / `unloaded` events

Plugin ids are unique. Registering a different plugin under an existing id is
rejected, and an external plugin cannot be unloaded while one of its runtimes
is active.
