import type { RunStatusState } from './types';

export type RunStatusItemId =
  | 'agent'
  | 'model'
  | 'service-tier'
  | 'reasoning'
  | 'weekly-limit'
  | 'context'
  | 'throughput'
  | 'elapsed';

export interface RunStatusItem {
  id: RunStatusItemId;
  icon: string;
  value: string;
}

export interface RunStatusItemOption {
  id: RunStatusItemId;
  icon: string;
  label: string;
  description: string;
}

/** Stable presentation catalog shared by config UI and render policy. */
export const RUN_STATUS_ITEM_OPTIONS: readonly RunStatusItemOption[] = [
  { id: 'agent', icon: '⬢', label: 'Agent', description: '本次运行使用的 Agent' },
  { id: 'model', icon: '◈', label: '模型', description: '实际或请求的模型' },
  { id: 'service-tier', icon: '⚡', label: 'Fast 模式', description: '引擎实际使用的速度档位' },
  { id: 'reasoning', icon: '✦', label: '推理强度', description: '本次运行的推理配置' },
  { id: 'weekly-limit', icon: '◉', label: '周额度', description: '账号周额度剩余比例' },
  { id: 'context', icon: '◎', label: '上下文', description: '当前上下文窗口剩余比例' },
  { id: 'throughput', icon: '↯', label: '生成速度', description: '模型输出 tokens/s' },
  { id: 'elapsed', icon: '◷', label: '运行耗时', description: '本次运行总耗时' },
];

const ITEM_OPTIONS = new Map(RUN_STATUS_ITEM_OPTIONS.map((option) => [option.id, option]));

function item(id: RunStatusItemId, value: string): RunStatusItem {
  return { id, icon: ITEM_OPTIONS.get(id)!.icon, value };
}

interface RunStatusItemDefinition {
  id: RunStatusItemId;
  select(status: RunStatusState): RunStatusItem | undefined;
}

const DEFINITIONS: Readonly<Record<RunStatusItemId, RunStatusItemDefinition>> = {
  agent: {
    id: 'agent',
    select: (status) => {
      const value = status.identity.agentId === 'codex'
        ? 'Codex'
        : status.identity.agentLabel ?? status.identity.agentId;
      return value ? item('agent', value) : undefined;
    },
  },
  model: {
    id: 'model',
    select: (status) => {
      const hasRunContext = Boolean(
        status.identity.agentId
        || status.identity.agentLabel
        || status.model.requested
        || status.model.actual
        || status.reasoningEffort,
      );
      if (!hasRunContext) return undefined;
      const value = status.model.actual
        ?? status.model.requested
        ?? (status.model.state === 'unavailable' ? '默认模型（未上报）' : '默认模型（解析中）');
      return item('model', value);
    },
  },
  reasoning: {
    id: 'reasoning',
    select: (status) => status.reasoningEffort
      ? item('reasoning', status.reasoningEffort)
      : undefined,
  },
  'service-tier': {
    id: 'service-tier',
    select: (status) => {
      if (status.serviceTier === undefined) return undefined;
      if (status.serviceTier === null || status.serviceTier === 'default') {
        return item('service-tier', 'Fast off');
      }
      if (status.serviceTier === 'fast') return item('service-tier', 'Fast on');
      return item('service-tier', `tier · ${status.serviceTier}`);
    },
  },
  'weekly-limit': {
    id: 'weekly-limit',
    select: (status) => status.quota.weekly
      ? item('weekly-limit', `weekly · ${status.quota.weekly.remainingPercent}% left`)
      : undefined,
  },
  context: {
    id: 'context',
    select: (status) => {
      const { usedTokens, totalTokens } = status.context;
      if (usedTokens === undefined || totalTokens === undefined || totalTokens <= 0) return undefined;
      const remaining = Math.min(
        100,
        Math.max(0, Math.round(100 - (usedTokens / totalTokens) * 100)),
      );
      return item('context', `context · ${remaining}% left`);
    },
  },
  throughput: {
    id: 'throughput',
    select: (status) => {
      const value = status.performance.generation?.tokensPerSecond;
      if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
      return item('throughput', `≈${formatTokensPerSecond(value)} tok/s`);
    },
  },
  elapsed: {
    id: 'elapsed',
    select: (status) => status.timing.elapsedMs !== undefined
      ? item('elapsed', formatElapsed(status.timing.elapsedMs))
      : undefined,
  },
};

export const DEFAULT_RUN_STATUS_ITEMS: readonly RunStatusItemId[] =
  RUN_STATUS_ITEM_OPTIONS.map((option) => option.id);

const RUN_STATUS_ITEM_IDS = new Set<RunStatusItemId>(DEFAULT_RUN_STATUS_ITEMS);

export function isRunStatusItemId(value: unknown): value is RunStatusItemId {
  return typeof value === 'string' && RUN_STATUS_ITEM_IDS.has(value as RunStatusItemId);
}

/** Resolve ordered semantic items; target-specific rendering happens later. */
export function resolveRunStatusItems(
  status: RunStatusState,
  ids: readonly RunStatusItemId[] = DEFAULT_RUN_STATUS_ITEMS,
): RunStatusItem[] {
  return ids.flatMap((id) => {
    const item = DEFINITIONS[id].select(status);
    return item ? [item] : [];
  });
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

function formatTokensPerSecond(value: number): string {
  return value < 10 ? value.toFixed(1) : String(Math.round(value));
}
