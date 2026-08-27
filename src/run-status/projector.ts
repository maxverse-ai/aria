import type { AgentEvent } from '../agent/types';
import type { RunStatusState } from './types';

/** Pure projection from normalized agent facts into the per-run status state. */
export function projectRunStatus(state: RunStatusState, event: AgentEvent): RunStatusState {
  if (event.type === 'system') {
    const modelChanged = Boolean(
      event.model
      && (state.model.actual !== event.model || state.model.state !== 'resolved'),
    );
    const reasoningChanged = Boolean(
      event.reasoningEffort
      && state.reasoningEffort !== event.reasoningEffort,
    );
    if (!modelChanged && !reasoningChanged) return state;
    return {
      ...state,
      ...(modelChanged && event.model
        ? { model: { ...state.model, actual: event.model, state: 'resolved' as const } }
        : {}),
      ...(reasoningChanged && event.reasoningEffort
        ? { reasoningEffort: event.reasoningEffort }
        : {}),
    };
  }

  if (event.type === 'usage') {
    const usage = {
      ...state.usage,
      ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
      ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
      ...(event.cachedInputTokens !== undefined ? { cachedInputTokens: event.cachedInputTokens } : {}),
      ...(event.reasoningOutputTokens !== undefined
        ? { reasoningOutputTokens: event.reasoningOutputTokens }
        : {}),
      ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
    };
    const context = {
      ...state.context,
      ...(event.contextUsedTokens !== undefined
        ? { usedTokens: event.contextUsedTokens }
        : {}),
      ...(event.contextWindowTokens !== undefined
        ? { totalTokens: event.contextWindowTokens }
        : {}),
    };
    if (sameUsage(state.usage, usage) && sameContext(state.context, context)) return state;
    return { ...state, usage, context };
  }

  if (event.type === 'performance') {
    const current = state.performance.generation;
    const next = event.generation;
    if (
      current?.tokensPerSecond === next.tokensPerSecond
      && current.outputTokens === next.outputTokens
      && current.decodeMs === next.decodeMs
      && current.sampleCount === next.sampleCount
      && current.source === next.source
    ) return state;
    return {
      ...state,
      performance: { ...state.performance, generation: next },
    };
  }

  if (
    (event.type === 'done' || event.type === 'error')
    && state.model.state === 'resolving'
  ) {
    return { ...state, model: { ...state.model, state: 'unavailable' } };
  }

  return state;
}

export function finalizeRunStatus(state: RunStatusState): RunStatusState {
  if (state.model.state !== 'resolving') return state;
  return { ...state, model: { ...state.model, state: 'unavailable' } };
}

export function setRunStatusElapsed(state: RunStatusState, elapsedMs: number): RunStatusState {
  const normalized = Math.max(0, Math.round(elapsedMs));
  if (state.timing.elapsedMs === normalized) return state;
  return { ...state, timing: { ...state.timing, elapsedMs: normalized } };
}

function sameUsage(
  left: RunStatusState['usage'],
  right: RunStatusState['usage'],
): boolean {
  return left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cachedInputTokens === right.cachedInputTokens
    && left.reasoningOutputTokens === right.reasoningOutputTokens
    && left.costUsd === right.costUsd;
}

function sameContext(
  left: RunStatusState['context'],
  right: RunStatusState['context'],
): boolean {
  return left.usedTokens === right.usedTokens
    && left.totalTokens === right.totalTokens;
}
