export type DevinJsonRpcId = number | string;

export interface DevinJsonRpcRequest {
  jsonrpc: '2.0';
  id: DevinJsonRpcId;
  method: string;
  params?: unknown;
}

export interface DevinJsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: unknown;
}

export interface DevinJsonRpcResponse {
  jsonrpc?: '2.0';
  id: DevinJsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface DevinInitializeResult {
  protocolVersion?: number;
  authMethods?: Array<{ id?: string; name?: string }>;
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean };
    session?: { inject?: DevinSessionInjectCapability };
    sessionCapabilities?: {
      list?: unknown;
      inject?: DevinSessionInjectCapability;
    };
  };
}

/** ACP v2's negotiated mid-turn input surface. */
export interface DevinSessionInjectCapability {
  modes?: unknown;
  steer_in_stream?: unknown;
  pending?: unknown;
}

export interface DevinInjectResult {
  messageId?: string;
  sessionId?: string;
  _meta?: Record<string, unknown>;
}

export interface DevinSessionResult {
  sessionId?: string;
  modes?: {
    currentModeId?: string;
    availableModes?: Array<{ id?: string; name?: string }>;
  };
  configOptions?: DevinSessionConfigOption[];
  models?: {
    currentModelId?: string;
    availableModels?: Array<{ modelId?: string; name?: string }>;
  };
  _meta?: Record<string, unknown>;
}

/**
 * ACP session config options (`session/set_config_option`). Devin exposes
 * per-session switches — notably model and permission mode — through this
 * list rather than dedicated methods.
 */
export interface DevinSessionConfigOption {
  id?: string;
  name?: string;
  type?: string;
  currentValue?: string;
  options?: Array<{ value?: string; name?: string }>;
}

export interface DevinPromptResult {
  stopReason?: string;
  usage?: unknown;
  _meta?: Record<string, unknown>;
}

export interface DevinSessionUpdateParams {
  sessionId?: string;
  update?: Record<string, unknown>;
}

export interface DevinUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
  contextUsedTokens?: number;
  contextWindowTokens?: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractSessionId(value: unknown, fallback?: string): string | undefined {
  if (!isRecord(value)) return fallback;
  if (typeof value.sessionId === 'string' && value.sessionId) return value.sessionId;
  const meta = isRecord(value._meta) ? value._meta : undefined;
  return typeof meta?.sessionId === 'string' && meta.sessionId ? meta.sessionId : fallback;
}

export function extractDevinUsage(value: unknown): DevinUsage | undefined {
  if (!isRecord(value)) return;
  const meta = isRecord(value._meta) ? value._meta : undefined;
  const candidates = [
    isRecord(value.usage) ? value.usage : undefined,
    isRecord(meta?.usage) ? meta.usage : undefined,
    meta,
  ];
  const inputTokens = firstFinite(candidates, ['input_tokens', 'inputTokens']);
  const outputTokens = firstFinite(candidates, ['output_tokens', 'outputTokens']);
  const cachedInputTokens = firstFinite(candidates, [
    'cache_read_input_tokens',
    'cached_input_tokens',
    'cacheReadInputTokens',
    'cachedInputTokens',
    'cachedReadTokens',
  ]);
  const reasoningOutputTokens = firstFinite(candidates, [
    'reasoning_output_tokens',
    'reasoningOutputTokens',
    'reasoningTokens',
  ]);
  const contextUsedTokens = firstFinite(candidates, [
    'context_used_tokens',
    'contextUsedTokens',
    'used',
  ]);
  const contextWindowTokens = firstFinite(candidates, [
    'context_window_tokens',
    'contextWindowTokens',
    'size',
  ]);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    reasoningOutputTokens === undefined &&
    contextUsedTokens === undefined &&
    contextWindowTokens === undefined
  ) return;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(contextUsedTokens !== undefined ? { contextUsedTokens } : {}),
    ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}),
  };
}

/** Find a session config option by id/name match, e.g. the model picker. */
export function findConfigOption(
  options: readonly DevinSessionConfigOption[] | undefined,
  pattern: RegExp,
): DevinSessionConfigOption | undefined {
  return options?.find((option) =>
    (typeof option.id === 'string' && pattern.test(option.id)) ||
    (typeof option.name === 'string' && pattern.test(option.name)),
  );
}

function firstFinite(
  candidates: Array<Record<string, unknown> | undefined>,
  keys: readonly string[],
): number | undefined {
  for (const candidate of candidates) {
    if (!candidate) continue;
    for (const key of keys) {
      const value = finiteNumber(candidate[key]);
      if (value !== undefined) return value;
    }
  }
  return;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function supportsDevinSteering(result: DevinInitializeResult | undefined): boolean {
  const capabilities = result?.agentCapabilities;
  const inject = capabilities?.session?.inject ?? capabilities?.sessionCapabilities?.inject;
  return isRecord(inject)
    && Array.isArray(inject.modes)
    && inject.modes.includes('steer');
}
