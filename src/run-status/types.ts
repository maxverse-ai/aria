/** Engine-agnostic facts shown in the compact status line for one run. */
export interface RunStatusState {
  identity: {
    agentId?: string;
    agentLabel?: string;
  };
  model: {
    requested?: string;
    actual?: string;
    state: 'resolving' | 'resolved' | 'unavailable';
  };
  reasoningEffort?: string;
  quota: {
    weekly?: {
      remainingPercent: number;
      resetsAt?: number;
    };
  };
  context: {
    usedTokens?: number;
    totalTokens?: number;
  };
  timing: {
    elapsedMs?: number;
  };
  performance: {
    generation?: {
      tokensPerSecond: number;
      outputTokens: number;
      decodeMs: number;
      sampleCount: number;
      source: 'provider' | 'observed';
    };
  };
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    reasoningOutputTokens?: number;
    costUsd?: number;
  };
}

export interface RunStatusSeed {
  agentId?: string;
  agentLabel?: string;
  requestedModel?: string;
  reasoningEffort?: string;
  weeklyQuota?: {
    remainingPercent: number;
    resetsAt?: number;
  };
}

export function createRunStatus(seed: RunStatusSeed = {}): RunStatusState {
  return {
    identity: {
      ...(seed.agentId ? { agentId: seed.agentId } : {}),
      ...(seed.agentLabel ? { agentLabel: seed.agentLabel } : {}),
    },
    model: {
      ...(seed.requestedModel ? { requested: seed.requestedModel } : {}),
      state: 'resolving',
    },
    ...(seed.reasoningEffort ? { reasoningEffort: seed.reasoningEffort } : {}),
    quota: {
      ...(seed.weeklyQuota ? { weekly: seed.weeklyQuota } : {}),
    },
    context: {},
    timing: {},
    performance: {},
    usage: {},
  };
}
