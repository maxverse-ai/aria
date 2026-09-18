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
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: {
    loadSession?: boolean;
    promptCapabilities?: { image?: boolean };
    sessionCapabilities?: { list?: unknown };
  };
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

/**
 * Devin tags each prompt result with the id of the user message that opened
 * the turn (`_meta['cognition.ai/userMessageId']`). Two concurrent
 * `session/prompt` requests that resolve with the same id merged into one
 * turn — the observed prompt-merge signature. Absent or differing ids mean
 * the second prompt started a turn of its own.
 */
export function extractUserMessageId(result: unknown): string | undefined {
  if (!isRecord(result)) return;
  const meta = isRecord(result._meta) ? result._meta : undefined;
  const flat = meta?.['cognition.ai/userMessageId'];
  if (typeof flat === 'string' && flat) return flat;
  const nested = isRecord(meta?.['cognition.ai']) ? meta['cognition.ai'] : undefined;
  return typeof nested?.userMessageId === 'string' && nested.userMessageId
    ? nested.userMessageId
    : undefined;
}

export type DevinSteeringMethod = 'session/inject' | '_session/steering';

/**
 * Negotiated steering advertised in `initialize`. `session/inject` (ACP RFD
 * #1261, `session.inject.modes` containing 'steer') outranks the de-facto
 * `_session/steering` extension (`_meta.steering.supported`): inject carries
 * explicit modes and an agent-owned messageId. Nothing advertised means the
 * caller falls back to prompt-merge.
 */
export function negotiatedSteeringMethod(
  result: DevinInitializeResult | undefined,
): DevinSteeringMethod | undefined {
  if (!result) return;
  if (steeringInjectModes(result).includes('steer')) return 'session/inject';
  const meta = isRecord(result._meta) ? result._meta : undefined;
  const steering = meta?.steering;
  if (steering === true) return '_session/steering';
  if (isRecord(steering) && steering.supported === true) return '_session/steering';
  return;
}

/**
 * Tolerates the capability living under `agentCapabilities.session.inject`,
 * `agentCapabilities['session.inject']`, or `_meta['session.inject']` — the
 * RFD predates a settled wire location.
 */
function steeringInjectModes(result: DevinInitializeResult): readonly string[] {
  const caps = isRecord(result.agentCapabilities)
    ? result.agentCapabilities as Record<string, unknown>
    : undefined;
  const meta = isRecord(result._meta) ? result._meta : undefined;
  const candidates = [
    isRecord(caps?.session) ? caps.session : undefined,
    caps?.['session.inject'],
    meta?.['session.inject'],
    meta?.inject,
  ];
  for (const candidate of candidates) {
    const record = isRecord(candidate) ? candidate : undefined;
    const modes = record?.modes ?? (isRecord(record?.inject) ? record.inject.modes : undefined);
    if (Array.isArray(modes) && modes.some((mode) => typeof mode === 'string')) {
      return modes.filter((mode): mode is string => typeof mode === 'string');
    }
  }
  return [];
}
