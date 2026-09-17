import type { AgentAdapter } from '../types';
import type { ModelOption } from '../models';

export const ENGINE_RUNTIME_CONTRACT_VERSION = 1 as const;

/** How the runtime owns native engine processes for one Aria profile. */
export type EngineRuntimeTopology = 'one-shot' | 'profile-daemon' | 'session-pool';

/** Input kinds understood by the runtime after channel attachments are normalized. */
export type EngineInputKind = 'text' | 'image' | 'file';

/**
 * `none` leaves follow-ups in the conversation inbox. `gated` accepts them at
 * engine-defined safe points, while `direct` can inject them into the active
 * turn after a transport acknowledgement.
 */
export type EngineLiveInputMode = 'none' | 'gated' | 'direct';

export type EngineSessionFeature = 'resume' | 'list' | 'fork';
export type EngineControlFeature = 'interrupt' | 'model' | 'reasoning' | 'service-tier' | 'goal';
export type EngineInteractionFeature = 'approval' | 'question';
export type EngineTelemetryFeature = 'usage' | 'context' | 'rate-limits';

/** Semantic capabilities only; native protocol method names stay inside runtimes. */
export interface EngineRuntimeCapabilities {
  inputs: readonly EngineInputKind[];
  liveInput: {
    mode: EngineLiveInputMode;
    inputs: readonly EngineInputKind[];
  };
  sessions: readonly EngineSessionFeature[];
  controls: readonly EngineControlFeature[];
  interactions: readonly EngineInteractionFeature[];
  telemetry: readonly EngineTelemetryFeature[];
}

/** Stable, versioned description of one profile-owned runtime instance. */
export interface EngineRuntimeDescriptor {
  contractVersion: typeof ENGINE_RUNTIME_CONTRACT_VERSION;
  engineId: string;
  topology: EngineRuntimeTopology;
  capabilities: EngineRuntimeCapabilities;
}

export interface DefineEngineRuntimeDescriptorInput {
  engineId: string;
  topology: EngineRuntimeTopology;
  capabilities?: Partial<{
    inputs: readonly EngineInputKind[];
    liveInput: Partial<EngineRuntimeCapabilities['liveInput']>;
    sessions: readonly EngineSessionFeature[];
    controls: readonly EngineControlFeature[];
    interactions: readonly EngineInteractionFeature[];
    telemetry: readonly EngineTelemetryFeature[];
  }>;
}

/**
 * Build a complete descriptor from conservative defaults. Missing features
 * are unsupported; callers must never infer support from an engine id.
 */
export function defineEngineRuntimeDescriptor(
  input: DefineEngineRuntimeDescriptorInput,
): EngineRuntimeDescriptor {
  const descriptor: EngineRuntimeDescriptor = {
    contractVersion: ENGINE_RUNTIME_CONTRACT_VERSION,
    engineId: input.engineId,
    topology: input.topology,
    capabilities: {
      inputs: input.capabilities?.inputs ?? ['text'],
      liveInput: {
        mode: input.capabilities?.liveInput?.mode ?? 'none',
        inputs: input.capabilities?.liveInput?.inputs ?? [],
      },
      sessions: input.capabilities?.sessions ?? [],
      controls: input.capabilities?.controls ?? ['interrupt'],
      interactions: input.capabilities?.interactions ?? [],
      telemetry: input.capabilities?.telemetry ?? [],
    },
  };
  assertEngineRuntimeDescriptor(descriptor, input.engineId);
  return descriptor;
}

/** Validate descriptors crossing the dynamic plugin boundary. */
export function assertEngineRuntimeDescriptor(
  value: unknown,
  expectedEngineId?: string,
): asserts value is EngineRuntimeDescriptor {
  if (!isRecord(value)) throw new Error('runtime descriptor must be an object');
  if (value.contractVersion !== ENGINE_RUNTIME_CONTRACT_VERSION) {
    throw new Error(`unsupported runtime contract version: ${String(value.contractVersion)}`);
  }
  if (typeof value.engineId !== 'string' || value.engineId.length === 0) {
    throw new Error('runtime descriptor requires engineId');
  }
  if (expectedEngineId && value.engineId !== expectedEngineId) {
    throw new Error(
      `runtime descriptor engine id ${value.engineId} does not match ${expectedEngineId}`,
    );
  }
  if (!isAllowedValue(value.topology, ['one-shot', 'profile-daemon', 'session-pool'])) {
    throw new Error(`invalid runtime topology: ${String(value.topology)}`);
  }

  const capabilities = value.capabilities;
  if (!isRecord(capabilities)) throw new Error('runtime descriptor requires capabilities');
  assertFeatureList(capabilities.inputs, ['text', 'image', 'file'], 'inputs');
  assertFeatureList(capabilities.sessions, ['resume', 'list', 'fork'], 'sessions');
  assertFeatureList(
    capabilities.controls,
    ['interrupt', 'model', 'reasoning', 'service-tier', 'goal'],
    'controls',
  );
  assertFeatureList(capabilities.interactions, ['approval', 'question'], 'interactions');
  assertFeatureList(capabilities.telemetry, ['usage', 'context', 'rate-limits'], 'telemetry');

  const liveInput = capabilities.liveInput;
  if (!isRecord(liveInput) || !isAllowedValue(liveInput.mode, ['none', 'gated', 'direct'])) {
    throw new Error('runtime descriptor has invalid liveInput mode');
  }
  assertFeatureList(liveInput.inputs, ['text', 'image', 'file'], 'liveInput.inputs');
  const inputs = capabilities.inputs as unknown[];
  const liveInputs = liveInput.inputs as unknown[];
  if (liveInput.mode === 'none' && liveInputs.length > 0) {
    throw new Error('runtime descriptor cannot declare live inputs when liveInput mode is none');
  }
  if (liveInputs.some((input) => !inputs.includes(input))) {
    throw new Error('runtime descriptor live inputs must also be declared as inputs');
  }
}

function assertFeatureList(
  value: unknown,
  allowed: readonly string[],
  field: string,
): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => !isAllowedValue(item, allowed))) {
    throw new Error(`runtime descriptor has invalid ${field}`);
  }
}

function isAllowedValue(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === 'string' && allowed.includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface EngineUsageWindow {
  label: string;
  usedPercent: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

/** Optional live metadata exposed by a long-lived engine runtime. */
export interface EngineStatusSnapshot {
  model?: string;
  account?: string;
  plan?: string;
  contextWindow?: {
    usedTokens: number;
    totalTokens?: number;
  };
  rateLimits?: EngineUsageWindow[];
  updatedAt: number;
}

/**
 * One live engine instance owned by a profile runtime.
 *
 * `execution` preserves the existing AgentAdapter contract. Engines that later
 * own long-lived processes, sockets, or subscriptions can release them from
 * `dispose` without leaking engine-specific lifecycle details into Supervisor.
 */
export interface EngineRuntime {
  readonly engineId: string;
  readonly descriptor: EngineRuntimeDescriptor;
  readonly execution: AgentAdapter;
  /** False fences new borrowers; the owner must drain and dispose before replacement. */
  isReusable?(): boolean;
  statusSnapshot?(): Promise<EngineStatusSnapshot>;
  /** Models exposed by the live engine connection, when supported. */
  listModels?(signal: AbortSignal): Promise<ModelOption[]>;
  dispose(): Promise<void>;
}
