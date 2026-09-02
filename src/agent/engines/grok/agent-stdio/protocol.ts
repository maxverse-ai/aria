export type GrokJsonRpcId = number | string;

export interface GrokJsonRpcRequest {
  jsonrpc: '2.0';
  id: GrokJsonRpcId;
  method: string;
  params?: unknown;
}

export interface GrokJsonRpcNotification {
  jsonrpc?: '2.0';
  method: string;
  params?: unknown;
}

export interface GrokJsonRpcResponse {
  jsonrpc?: '2.0';
  id: GrokJsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface GrokInitializeResult {
  protocolVersion?: number;
  authMethods?: Array<{ id?: string; name?: string }>;
  agentCapabilities?: {
    loadSession?: boolean;
    sessionCapabilities?: Record<string, unknown>;
  };
  _meta?: {
    modelState?: GrokModelState;
    defaultAuthMethodId?: string;
    [key: string]: unknown;
  };
}

export interface GrokModelState {
  currentModelId?: string;
  availableModels?: Array<{
    modelId?: string;
    name?: string;
    _meta?: {
      reasoningEffort?: string;
      reasoningEfforts?: Array<string | {
        id?: string;
        value?: string;
        default?: boolean;
      }>;
      [key: string]: unknown;
    };
  }>;
}

export interface GrokSessionResult {
  sessionId?: string;
  _meta?: { sessionId?: string; [key: string]: unknown };
}

export interface GrokPromptResult {
  stopReason?: string;
  usage?: unknown;
  _meta?: {
    usage?: unknown;
    agentResult?: unknown;
    [key: string]: unknown;
  };
}

export interface GrokSessionUpdateParams {
  sessionId?: string;
  update?: Record<string, unknown>;
  sessionUpdate?: string | Record<string, unknown>;
}

export interface GrokUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningOutputTokens?: number;
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

export function extractGrokUsage(value: unknown): GrokUsage | undefined {
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
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    reasoningOutputTokens === undefined
  ) return;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
  };
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
