import type { SecretRef } from '../../config/schema';
import type { JsonValue } from '../../session/jcs';

export const CHANNEL_PLUGIN_ABI_VERSION = 1 as const;

export type ChannelMessageKind = 'text' | 'image' | 'file' | 'audio' | 'event';
export type ChannelIngressMode = 'push' | 'callback-pull' | 'poll';
export type ChannelStreamingMode = 'none' | 'append' | 'replace';
export type ChannelConversationKind = 'p2p' | 'group' | 'thread';

export interface ChannelCapabilities {
  ingress: ChannelIngressMode;
  inbound: readonly ChannelMessageKind[];
  outbound: readonly ChannelMessageKind[];
  streaming: ChannelStreamingMode;
  conversations: readonly ChannelConversationKind[];
  proactiveMessages: boolean;
  humanHandoff: boolean;
}

export interface ChannelPluginManifest {
  abiVersion: typeof CHANNEL_PLUGIN_ABI_VERSION;
  id: string;
  displayName: string;
  package: {
    name: string;
    version: string;
  };
  configVersion: number;
  /** Serializable JSON Schema subset for management and package inspection. */
  configSchema: Readonly<Record<string, JsonValue>>;
  capabilities: ChannelCapabilities;
}

export type ChannelConfig = Readonly<Record<string, JsonValue>>;

export interface ChannelInstanceRef {
  profileId: string;
  pluginId: string;
  instanceId: string;
}

export interface ResolvedChannelInstance<TConfig extends ChannelConfig = ChannelConfig>
  extends ChannelInstanceRef {
  enabled: boolean;
  configVersion: number;
  config: TConfig;
  secretRefs: Readonly<Record<string, SecretRef>>;
}

export interface ChannelAssetContent {
  kind: 'image' | 'file' | 'audio';
  assetRef: string;
  contentType: string;
  filename?: string;
  size?: number;
}

export type ChannelContent =
  | { kind: 'text'; text: string }
  | ChannelAssetContent
  | { kind: 'event'; name: string; data: JsonValue };

/** A serializable provider message accepted at the channel/core boundary. */
export interface ChannelInboundEnvelope extends ChannelInstanceRef {
  abiVersion: typeof CHANNEL_PLUGIN_ABI_VERSION;
  sourceMessageId: string;
  scopeId: string;
  actorId: string;
  conversation: ChannelConversationKind;
  occurredAt: number;
  content: ChannelContent;
  attachments?: readonly ChannelAssetContent[];
  /** Provider reply state is opaque to core and must remain JSON-serializable. */
  replyContext?: JsonValue;
}

export interface ChannelIngressAcceptance {
  status: 'accepted' | 'duplicate';
  receiptId: string;
}

/** Core-owned durable ingress. Plugins cannot call agent execution directly. */
export interface ChannelIngressPort {
  accept(envelope: ChannelInboundEnvelope): Promise<ChannelIngressAcceptance>;
}

export interface ChannelOutboundIntent extends ChannelInstanceRef {
  abiVersion: typeof CHANNEL_PLUGIN_ABI_VERSION;
  deliveryId: string;
  scopeId: string;
  /** Required for ordinary replies; absent only for authorized proactive sends. */
  sourceMessageId?: string;
  content: ChannelContent;
  attachments?: readonly ChannelAssetContent[];
  replyContext?: JsonValue;
}

export interface ChannelDeliveryReceipt {
  deliveryId: string;
  status: 'accepted' | 'sent';
  providerMessageId?: string;
  deliveredAt: number;
}

export type ChannelRuntimeState =
  | 'starting'
  | 'ready'
  | 'draining'
  | 'stopped'
  | 'failed'
  | 'reauth-required';

export interface ChannelRuntimeSnapshot extends ChannelInstanceRef {
  state: ChannelRuntimeState;
  acceptingInbound: boolean;
  inFlightInbound: number;
  inFlightOutbound: number;
  updatedAt: number;
}

export interface ChannelHealthSnapshot {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'reauth-required';
  checkedAt: number;
  /** Stable diagnostic code. Human/provider payloads do not belong here. */
  code?: string;
}

export interface ChannelDrainOptions {
  deadlineAt: number;
}

export interface ChannelDrainResult {
  drained: boolean;
  remainingInbound: number;
  remainingOutbound: number;
}

export interface ChannelPluginContext<TConfig extends ChannelConfig = ChannelConfig> {
  instance: ResolvedChannelInstance<TConfig>;
  ingress: ChannelIngressPort;
  signal: AbortSignal;
}

/** One started channel instance. close() must be idempotent. */
export interface ChannelRuntime {
  readonly instance: ChannelInstanceRef;
  snapshot(): ChannelRuntimeSnapshot;
  health(): Promise<ChannelHealthSnapshot>;
  deliver(intent: ChannelOutboundIntent): Promise<ChannelDeliveryReceipt>;
  drain(options: ChannelDrainOptions): Promise<ChannelDrainResult>;
  close(): Promise<void>;
}

export interface ChannelPlugin<TConfig extends ChannelConfig = ChannelConfig> {
  readonly manifest: ChannelPluginManifest;
  validateConfig(config: unknown): TConfig;
  start(context: ChannelPluginContext<TConfig>): Promise<ChannelRuntime>;
}

export interface ChannelPluginPackage {
  channelPlugin: ChannelPlugin;
}
