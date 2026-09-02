# Channel Plugin ABI v1

Channel Plugin ABI v1 is Aria's serializable boundary between channel-specific
protocol code and core-owned ingress, lifecycle, and delivery orchestration. It
is available from the package root; plugins do not import Supervisor, agent, or
session internals.

ABI v1 is an integration contract, not a production cutover. The Stage 1
registry is not composed by Supervisor, and existing Lark and `wechat-kf`
startup paths remain unchanged until their later migration stages.

## Package contract

A package exports one `ChannelPluginPackage`. Its manifest declares an exact ABI
version, canonical plugin id, package identity, configuration version and JSON
schema, and factual protocol capabilities. Runtime validation rejects malformed
or unsupported declarations before startup.

```ts
import {
  CHANNEL_PLUGIN_ABI_VERSION,
  type ChannelPluginPackage,
} from '@maxverse-ai/aria';

export const channelPluginPackage: ChannelPluginPackage = {
  channelPlugin: {
    manifest: {
      abiVersion: CHANNEL_PLUGIN_ABI_VERSION,
      id: 'example-chat',
      displayName: 'Example Chat',
      package: { name: '@example/aria-channel-example-chat', version: '1.0.0' },
      configVersion: 1,
      configSchema: { type: 'object' },
      capabilities: {
        ingress: 'poll',
        inbound: ['text'],
        outbound: ['text'],
        streaming: 'none',
        conversations: ['p2p'],
        proactiveMessages: false,
        humanHandoff: false,
      },
    },
    validateConfig(config) {
      return config as Record<string, never>;
    },
    async start(context) {
      // Connect to the provider and submit normalized messages only through
      // context.ingress.accept(...). Return the instance runtime here.
      throw new Error(`not implemented: ${context.instance.instanceId}`);
    },
  },
};
```

The ids `wechat`, `weixin`, `wx`, and `wxkf` are reserved aliases and cannot be
registered. Customer Service uses `wechat-kf`; personal WeChat iLink uses
`weixin-ilink`.

## Runtime invariants

- Every runtime is keyed by `(profileId, pluginId, instanceId)`. Cross-instance
  inbound messages, outbound intents, snapshots, and duplicate starts fail
  validation.
- Public configuration and provider reply context must contain plain,
  non-cyclic JSON values. Credentials are supplied separately as `SecretRef`
  values.
- A plugin can emit only declared message and conversation kinds. Proactive
  delivery is rejected unless explicitly declared.
- Core validates ingress acceptance, snapshots, health, drain results, and
  delivery receipts returned across the boundary.
- `close()` is managed as an idempotent operation. Shutdown attempts every
  active runtime and reports aggregate failure after cleanup.

Plugins classify operational failures with `ChannelPluginError`. Only
`transient` failures are retryable and may carry `retryAfterMs`;
`authentication`, `configuration`, `unsupported-capability`, and `permanent`
failures require a different core action.

## Contract testing

`runChannelPluginContract()` is framework-neutral and exercises one validated
plugin instance through ingress, snapshot, health, delivery, drain, and repeated
close. Plugin repositories can call it from Vitest, Jest, Node test, or another
runner and add provider-specific failure/restart fixtures around it.

Package discovery, process isolation, persisted instance configuration, shared
reliability stores, and production ChannelManager composition are deliberately
outside ABI v1 and ship in later stages of the channel platform plan.
