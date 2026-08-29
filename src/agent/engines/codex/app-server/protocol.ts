export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ThreadStartResponse {
  thread: { id: string };
  model: string;
  reasoningEffort?: string | null;
  /** Added by newer App Server versions; optional keeps older binaries usable. */
  serviceTier?: string | null;
}

export interface ThreadResumeResponse {
  thread: { id: string };
  model: string;
  reasoningEffort?: string | null;
  /** Added by newer App Server versions; optional keeps older binaries usable. */
  serviceTier?: string | null;
}

export interface TurnStartResponse {
  turn: { id: string };
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  planType: string | null;
}

export interface AccountRateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId: Record<string, RateLimitSnapshot> | null;
}

export interface AccountResponse {
  account:
    | { type: 'chatgpt'; email: string | null; planType: string }
    | { type: 'apiKey' }
    | { type: 'amazonBedrock'; usesCodexManagedCredentials: boolean }
    | null;
  requiresOpenaiAuth: boolean;
}

export interface ModelListResponse {
  data: Array<{
    id: string;
    model: string;
    displayName: string;
    isDefault: boolean;
    defaultReasoningEffort?: string;
    supportedReasoningEfforts?: Array<{
      reasoningEffort: string;
      description: string;
    }>;
    multiAgentVersion?: string | null;
    serviceTiers?: Array<{
      id: string;
      name: string;
      description: string;
    }>;
    defaultServiceTier?: string | null;
  }>;
  nextCursor: string | null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
