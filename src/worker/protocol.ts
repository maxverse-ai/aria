import type { EngineRuntimeDescriptor } from '../agent/runtime/types';
import type { AgentEvent } from '../agent/types';
import type { AgentAttachment } from '../policy/run-policy';

export const ARIA_WORKER_PROTOCOL_VERSION = 1 as const;

export const ARIA_WORKER_METHODS = [
  'runtime.handshake',
  'runtime.health',
  'run.start',
  'run.interrupt',
  'session.reset',
  'runtime.shutdown',
] as const;

export type AriaWorkerMethod = (typeof ARIA_WORKER_METHODS)[number];
export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface WorkerHandshakeResult {
  protocolVersion: typeof ARIA_WORKER_PROTOCOL_VERSION;
  workerVersion: string;
  profile: string;
  engine: EngineRuntimeDescriptor;
  methods: readonly AriaWorkerMethod[];
}

export interface WorkerHealthResult {
  ready: boolean;
  activeOperations: number;
  completedOperations: number;
}

export interface RunStartParams {
  operationId: string;
  scopeRef: string;
  actorRef: string;
  prompt: string;
  authorization: {
    decision: 'allow' | 'deny';
    reference: string;
  };
  source?: `channel:${string}`;
  sourceMessageId?: string;
  attachments?: AgentAttachment[];
}

export interface RunAcceptedResult {
  operationId: string;
  state: 'accepted' | 'running' | 'completed' | 'failed';
  duplicate: boolean;
  runId?: string;
}

export interface WorkerRunEvent {
  operationId: string;
  sequence: number;
  event: AgentEvent;
}

export interface WorkerRunCompleted {
  operationId: string;
  sequence: number;
  runId: string;
  content: string;
}

export interface WorkerRunFailed {
  operationId: string;
  sequence: number;
  code: string;
  message: string;
}

export class WorkerProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'WorkerProtocolError';
  }
}

export function parseRequest(value: unknown): JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== '2.0') {
    throw new WorkerProtocolError(-32600, 'invalid JSON-RPC request');
  }
  if (typeof value.id !== 'string' && typeof value.id !== 'number') {
    throw new WorkerProtocolError(-32600, 'request id must be a string or number');
  }
  if (typeof value.method !== 'string' || value.method.length === 0) {
    throw new WorkerProtocolError(-32600, 'request method is required');
  }
  return {
    jsonrpc: '2.0',
    id: value.id,
    method: value.method,
    ...(value.params === undefined ? {} : { params: value.params }),
  };
}

export function parseRunStartParams(value: unknown): RunStartParams {
  if (!isRecord(value)) throw invalidParams('run.start params must be an object');
  const operationId = requiredString(value.operationId, 'operationId');
  const scopeRef = requiredString(value.scopeRef, 'scopeRef');
  const actorRef = requiredString(value.actorRef, 'actorRef');
  if (typeof value.prompt !== 'string') throw invalidParams('prompt must be a string');
  if (!value.prompt.trim() && !hasAcceptedAttachment(value.attachments)) {
    throw invalidParams('prompt or an accepted attachment is required');
  }
  if (!isRecord(value.authorization)) {
    throw invalidParams('authorization must be an object');
  }
  if (value.authorization.decision !== 'allow' && value.authorization.decision !== 'deny') {
    throw invalidParams('authorization.decision must be allow or deny');
  }
  const reference = requiredString(value.authorization.reference, 'authorization.reference');
  if (value.source !== undefined && (
    typeof value.source !== 'string' || !value.source.startsWith('channel:')
  )) {
    throw invalidParams('source must use the channel:<id> form');
  }
  if (value.sourceMessageId !== undefined && typeof value.sourceMessageId !== 'string') {
    throw invalidParams('sourceMessageId must be a string');
  }
  if (value.attachments !== undefined && !Array.isArray(value.attachments)) {
    throw invalidParams('attachments must be an array');
  }
  return {
    operationId,
    scopeRef,
    actorRef,
    prompt: value.prompt,
    authorization: { decision: value.authorization.decision, reference },
    ...(value.source === undefined ? {} : { source: value.source as `channel:${string}` }),
    ...(value.sourceMessageId === undefined ? {} : { sourceMessageId: value.sourceMessageId }),
    attachments: (value.attachments ?? []) as AgentAttachment[],
  };
}

export function requiredScopeRef(value: unknown): string {
  if (!isRecord(value)) throw invalidParams('params must be an object');
  return requiredString(value.scopeRef, 'scopeRef');
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw invalidParams(`${field} is required`);
  }
  return value;
}

function hasAcceptedAttachment(value: unknown): boolean {
  return Array.isArray(value) && value.some(
    (attachment) => isRecord(attachment) && attachment.decision === 'accepted',
  );
}

function invalidParams(message: string): WorkerProtocolError {
  return new WorkerProtocolError(-32602, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
