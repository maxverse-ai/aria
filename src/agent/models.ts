/**
 * Sentinel selection meaning "don't pass `--model`; let the agent CLI /
 * account decide". Kept as a real option value (rather than empty string)
 * because Feishu's `select_static` requires `initial_option` to match one of
 * the option `value`s exactly and rejects an empty string.
 */
export const DEFAULT_MODEL = 'default';

export interface ReasoningOption {
  /** Engine-native value. Deliberately open-ended for future runtimes. */
  value: string;
  label: string;
  description?: string;
  /** Some Codex values (notably ultra) also change orchestration behavior. */
  semantics?: 'effort' | 'multi-agent';
}

export interface ModelReasoningCapability {
  options: ReasoningOption[];
  defaultValue?: string;
}

export interface ServiceTierOption {
  /** Engine-native service tier id (for example Codex `fast`). */
  value: string;
  label: string;
  description?: string;
}

export interface ModelServiceTierCapability {
  options: ServiceTierOption[];
  /** Runtime-declared default tier; absent/null means the standard tier. */
  defaultValue?: string;
}

export interface ModelOption {
  /**
   * Stored in `preferences.model` and forwarded to the agent's `--model`
   * flag. `DEFAULT_MODEL` is special-cased to omit the flag entirely.
   */
  value: string;
  /** Human-facing label shown in the `/config` picker. */
  label: string;
  /** Runtime-declared default model for a `default` selection. */
  isDefault?: boolean;
  /** Model-specific reasoning controls, when the engine can prove them. */
  reasoning?: ModelReasoningCapability;
  /** Model-specific execution service tiers, when the engine can prove them. */
  serviceTiers?: ModelServiceTierCapability;
}

/**
 * Claude Code models. Pinned to concrete version ids (Claude Code's `--model`
 * accepts the full model-id string, not just the `opus`/`sonnet` aliases) so
 * the picker names an exact model. Add new ids here when a generation ships;
 * `opusplan` is kept as the one alias with no versioned equivalent (it runs
 * Opus for planning and Sonnet for execution).
 */
export const CLAUDE_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8（最新）' },
  { value: 'claude-opus-4-7', label: 'Opus 4.7' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5（最新）' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5（最新）' },
  { value: 'opusplan', label: 'Opus Plan（规划用 Opus，执行用 Sonnet）' },
];

/** Codex models. Forwarded to the managed App Server runtime. */
export const CODEX_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'gpt-5-codex', label: 'GPT-5 Codex' },
  { value: 'gpt-5', label: 'GPT-5' },
  { value: 'o3', label: 'o3' },
];

/** OpenCode models. Forwarded to `opencode run --model` as `provider/model`. */
export const OPENCODE_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'openai/gpt-5-codex', label: 'GPT-5 Codex' },
  { value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
];

/** DeepSeek Harness models. The headless profile resolves its default model. */
export const DSH_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'deepseek/deepseek-chat', label: 'DeepSeek Chat' },
  { value: 'deepseek/deepseek-reasoner', label: 'DeepSeek Reasoner' },
];

/** Kimi Code models (Claude-compatible CLI; ids follow the Kimi catalog). */
export const KIMI_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'kimi-k2', label: 'Kimi K2' },
  { value: 'kimi-k2-thinking', label: 'Kimi K2 Thinking' },
];

/** Pi models (provider/model patterns supported by `pi --model`). */
export const PI_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { value: 'openai/gpt-5-codex', label: 'GPT-5 Codex' },
];

/**
 * Devin CLI family aliases. Short names always resolve to the latest release
 * in the family server-side; `adaptive` is the account default router.
 */
export const DEVIN_MODELS: ModelOption[] = [
  { value: DEFAULT_MODEL, label: '跟随默认（不指定）' },
  { value: 'adaptive', label: 'Adaptive（自动路由）' },
  { value: 'fusion', label: 'Fusion（前沿模型 + 高性价比辅助）' },
  { value: 'swe', label: 'SWE（最新）' },
  { value: 'opus', label: 'Claude Opus（最新）' },
  { value: 'sonnet', label: 'Claude Sonnet（最新）' },
  { value: 'gpt', label: 'GPT（最新）' },
  { value: 'gemini', label: 'Gemini（最新）' },
  { value: 'codex', label: 'Codex（最新）' },
];

type ModelOptionsProvider = () => ModelOption[];

const modelOptionsProviders = new Map<string, ModelOptionsProvider>();

/** Engine plugins register their picker options here at module load. */
export function registerModelOptions(agentKind: string, provider: ModelOptionsProvider): void {
  modelOptionsProviders.set(agentKind, provider);
}

/** The model picker options for a profile's agent kind. */
export function supportedModels(agentKind: string): ModelOption[] {
  return modelOptionsProviders.get(agentKind)?.() ?? [];
}

/** True when the selection means "use the agent default" (no `--model`). */
export function isDefaultModel(value: string | undefined): boolean {
  return !value || value === DEFAULT_MODEL;
}

/**
 * Normalize the persisted selection without treating the built-in picker
 * catalog as a runtime allow-list. Dynamic providers may return models that
 * are intentionally absent from {@link supportedModels}; silently replacing
 * those values with `default` would make the UI and the actual run disagree.
 */
export function normalizeModelSelection(
  _agentKind: string,
  value: string | undefined,
): string {
  if (isDefaultModel(value)) return DEFAULT_MODEL;
  return value!.trim() || DEFAULT_MODEL;
}

/**
 * Resolve the concrete model string to hand the agent, or `undefined` to omit
 * the `--model` flag. Availability is validated when the user selects a model,
 * not again at execution time against a possibly stale static catalog.
 */
export function resolveModelArg(
  agentKind: string,
  value: string | undefined,
): string | undefined {
  const normalized = normalizeModelSelection(agentKind, value);
  return normalized === DEFAULT_MODEL ? undefined : normalized;
}

/** Picker label for a stored value, for display in the saved-config card. */
export function modelLabel(agentKind: string, value: string | undefined): string {
  const normalized = normalizeModelSelection(agentKind, value);
  return supportedModels(agentKind).find((m) => m.value === normalized)?.label ?? normalized;
}

/** Ensure a persisted dynamic model remains a valid picker initial option. */
export function includeConfiguredModel(
  options: ModelOption[],
  value: string | undefined,
): ModelOption[] {
  const normalized = normalizeModelSelection('', value);
  if (normalized === DEFAULT_MODEL || options.some((option) => option.value === normalized)) {
    return options;
  }
  return [
    ...options,
    { value: normalized, label: `${normalized}（当前配置，暂不可验证）` },
  ];
}

/** Resolve `default` to the runtime-declared concrete model when available. */
export function selectedModelDescriptor(
  options: ModelOption[],
  selected: string | undefined,
): ModelOption | undefined {
  const normalized = normalizeModelSelection('', selected);
  if (normalized === DEFAULT_MODEL) {
    return options.find((option) => option.isDefault)
      ?? options.find((option) => option.value === DEFAULT_MODEL);
  }
  return options.find((option) => option.value === normalized);
}

export function reasoningOptionsForModel(
  options: ModelOption[],
  selected: string | undefined,
): ReasoningOption[] {
  return selectedModelDescriptor(options, selected)?.reasoning?.options ?? [];
}

export function serviceTierOptionsForModel(
  options: ModelOption[],
  selected: string | undefined,
): ServiceTierOption[] {
  return selectedModelDescriptor(options, selected)?.serviceTiers?.options ?? [];
}
