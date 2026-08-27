# Aria Engine Plugins

Aria drives local coding-agent CLIs through a plugin registry. Claude Code,
Codex and OpenCode ship as built-in plugins; third-party engines (DeepSeek,
Kimi, Qoder, ...) can be loaded dynamically from npm packages.

## Contract

An engine plugin is an ES module that default-exports (or named-exports)
`enginePlugin`:

```ts
export const enginePlugin: EnginePlugin = {
  id: 'deepseek',                     // unique engine id
  displayName: 'DeepSeek CLI',
  sessionKind: 'deepseek-session',    // resume key: '-thread' => threadId, else sessionId
  supportsNativeHistory: true,
  probes: [{ command: 'deepseek', envKey: 'LARK_CHANNEL_DEEPSEEK_BIN' }],
  configField: 'deepseek',            // ProfileConfig field holding engine config
  defaultBinary: 'deepseek',
  defaultBinaryEnvKey: 'LARK_CHANNEL_DEEPSEEK_BIN',
  capability: (profile) => ({ ... }),
  createRuntime: (ctx) => ({
    engineId: 'deepseek',
    execution: new DeepSeekAdapter({ ... }),
    async dispose() { /* release processes, sockets and subscriptions */ },
  }),
  bootstrapConfig: async ({ binaryPath }) => ({ binaryPath: await resolve(binaryPath) }),
  listHistory: async ({ cwd, limit, profileConfig }) => [...],
  modelLister: async ({ profileConfig }) => [...],
  effortFlag: (value) => ['--reasoning-effort', value],
  statusPermission: (profile) => ({ label: 'sandbox', value: '...' }),
  modelOptions: () => [...],
};
```

The full interface lives in `src/agent/plugin/types.ts`.

## Loading

Add the package to a profile:

```json
{
  "agentKind": "deepseek",
  "plugins": ["@your-org/engine-deepseek"]
}
```

The supervisor imports the package at profile start, validates the manifest,
and registers it. `/agent` then lists the engine automatically; `/agent use
<id>` switches to it at runtime (in-process profile restart).

## Trust boundary

External plugins run **in-process** with the same privileges as the bridge.
Only install plugins you trust; pin exact versions.

## Lifecycle

- `loadExternalEnginePlugins(names)` — dynamic import + validation + register
- `createEngineRuntime(id, ctx)` — create a profile-owned execution runtime
- `runtime.dispose()` — release engine resources on stop, restart, switch, or failed startup
- `unloadEnginePlugin(id)` — remove an inactive dynamically loaded plugin
- `onEnginePluginEvent(listener)` — subscribe to `loaded` / `unloaded` events

Plugin ids are unique. Registering a different plugin under an existing id is
rejected, and an external plugin cannot be unloaded while one of its runtimes
is active.
