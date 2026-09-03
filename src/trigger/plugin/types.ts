import type { SecretRef } from '../../config/schema';
import type { JsonValue } from '../../session/jcs';

export const TRIGGER_PROVIDER_ABI_VERSION = 1 as const;

export type TriggerSourceKind = 'schedule' | 'webhook' | 'internal-event';
export type TriggerIngressMode = 'clock' | 'push' | 'poll';
export type TriggerReplayMode = 'source-event-id' | 'cursor' | 'none';

export interface TriggerProviderCapabilities {
  ingress: TriggerIngressMode;
  sources: readonly TriggerSourceKind[];
  replay: TriggerReplayMode;
  acknowledgements: boolean;
}

export interface TriggerProviderManifest {
  abiVersion: typeof TRIGGER_PROVIDER_ABI_VERSION;
  id: string;
  displayName: string;
  package: { name: string; version: string };
  configVersion: number;
  configSchema: Readonly<Record<string, JsonValue>>;
  capabilities: TriggerProviderCapabilities;
}

export type TriggerProviderConfig = Readonly<Record<string, JsonValue>>;

export interface TriggerInstanceRef {
  profileId: string;
  providerId: string;
  instanceId: string;
}

export interface ResolvedTriggerInstance<TConfig extends TriggerProviderConfig = TriggerProviderConfig>
  extends TriggerInstanceRef {
  enabled: boolean;
  configVersion: number;
  config: TConfig;
  secretRefs: Readonly<Record<string, SecretRef>>;
}

export interface TriggerActorEvidence {
  kind: 'user' | 'system' | 'agent';
  actorRef: string;
}

/**
 * Serializable provider observation accepted at the trigger/core boundary.
 * This is evidence, not authorization. Prompts, credentials and local paths
 * are intentionally absent and are resolved by core from a durable definition.
 */
export interface TriggerEnvelope extends TriggerInstanceRef {
  abiVersion: typeof TRIGGER_PROVIDER_ABI_VERSION;
  sourceKind: TriggerSourceKind;
  sourceEventId: string;
  triggerDefinitionId?: string;
  occurredAt: number;
  observedAt: number;
  scopeRef: string;
  actor: TriggerActorEvidence;
  data: JsonValue;
  cursor?: string;
}

export interface TriggerIngressAcceptance {
  status: 'accepted' | 'duplicate';
  receiptId: string;
}

/** Core-owned durable ingress. Providers cannot invoke agent execution. */
export interface TriggerIngressPort {
  accept(envelope: TriggerEnvelope): Promise<TriggerIngressAcceptance>;
}

export type TriggerRuntimeState =
  | 'starting'
  | 'ready'
  | 'draining'
  | 'stopped'
  | 'failed';

export interface TriggerRuntimeSnapshot extends TriggerInstanceRef {
  state: TriggerRuntimeState;
  acceptingEvents: boolean;
  inFlightEvents: number;
  updatedAt: number;
}

export interface TriggerHealthSnapshot {
  status: 'healthy' | 'degraded' | 'unhealthy';
  checkedAt: number;
  code?: string;
}

export interface TriggerDrainOptions { deadlineAt: number }
export interface TriggerDrainResult { drained: boolean; remainingEvents: number }

export interface TriggerProviderContext<TConfig extends TriggerProviderConfig = TriggerProviderConfig> {
  instance: ResolvedTriggerInstance<TConfig>;
  ingress: TriggerIngressPort;
  signal: AbortSignal;
}

export interface TriggerRuntime {
  readonly instance: TriggerInstanceRef;
  snapshot(): TriggerRuntimeSnapshot;
  health(): Promise<TriggerHealthSnapshot>;
  drain(options: TriggerDrainOptions): Promise<TriggerDrainResult>;
  close(): Promise<void>;
}

export interface TriggerProvider<TConfig extends TriggerProviderConfig = TriggerProviderConfig> {
  readonly manifest: TriggerProviderManifest;
  validateConfig(config: unknown): TConfig;
  start(context: TriggerProviderContext<TConfig>): Promise<TriggerRuntime>;
}

export interface TriggerProviderPackage { triggerProvider: TriggerProvider }
