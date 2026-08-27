import type {
  RecordConversationEventInput,
  StartConversationInput,
} from '../../conversation/runtime';
import type { StartRunFlowResult } from '../../bot/run-flow';

export type ChannelMessageKind = 'text' | 'image' | 'file' | 'audio' | 'event';
export type ChannelIngressMode = 'push' | 'callback-pull' | 'poll';
export type ChannelStreamingMode = 'none' | 'append' | 'replace';

export interface ChannelCapabilities {
  ingress: ChannelIngressMode;
  inbound: readonly ChannelMessageKind[];
  outbound: readonly ChannelMessageKind[];
  streaming: ChannelStreamingMode;
  supportsThreads: boolean;
  supportsHumanHandoff: boolean;
}

/** Narrow port exposed to channel plugins; execution internals stay in core. */
export interface ChannelConversationPort {
  start(input: StartConversationInput): Promise<StartRunFlowResult>;
  recordEvent(input: RecordConversationEventInput): void;
  interrupt(scopeId: string): boolean;
}

export interface ChannelPluginContext<TConfig = unknown> {
  profileId: string;
  config: TConfig;
  conversations: ChannelConversationPort;
  signal: AbortSignal;
}

export interface ChannelRuntimeSnapshot {
  acceptingInbound: boolean;
  inFlightInbound: number;
}

/** One started channel instance. close() must be idempotent. */
export interface ChannelRuntime {
  readonly channelId: string;
  readonly identity?: { id?: string; name?: string };
  snapshot(): ChannelRuntimeSnapshot;
  close(): Promise<void>;
}

export interface ChannelPlugin<TConfig = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ChannelCapabilities;
  start(context: ChannelPluginContext<TConfig>): Promise<ChannelRuntime>;
}

export interface ChannelPluginPackage {
  channelPlugin: ChannelPlugin;
}
