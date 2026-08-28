/**
 * Versioned, transport-neutral contracts for Aria's native read model.
 *
 * These DTOs describe the future Unix-socket/HTTP adapter without making the
 * application layer depend on a web framework. They are intentionally
 * separate from CONTROL_API_VERSION, which versions the existing config CLI.
 */
export const NATIVE_READ_API_VERSION = 1 as const;

export const NATIVE_READ_RESOURCE_TYPES = [
  'profile',
  'session',
  'message',
  'run',
  'identity',
  'chat',
  'chat-member',
  'audit-event',
] as const;

export type NativeReadResourceType = (typeof NATIVE_READ_RESOURCE_TYPES)[number];
export type NativeReadCursor = string;
export type NativeReadResolutionStatus = 'resolved' | 'pending' | 'failed' | 'unavailable';

export interface NativeReadMetaResponse {
  schema: 'aria.read.meta.v1';
  apiVersion: typeof NATIVE_READ_API_VERSION;
  instanceId: string;
  serverVersion: string;
  startedAt: string;
}

export interface NativeReadCapability {
  id: string;
  method: 'GET';
  route: (typeof NATIVE_READ_ROUTES)[number];
  requiredScopes: readonly string[];
  resourceType?: NativeReadResourceType;
}

export interface NativeReadCapabilitiesResponse {
  schema: 'aria.read.capabilities.v1';
  apiVersion: typeof NATIVE_READ_API_VERSION;
  instanceId: string;
  capabilities: readonly NativeReadCapability[];
}

export interface NativeReadHealthResponse {
  schema: 'aria.read.health.v1';
  apiVersion: typeof NATIVE_READ_API_VERSION;
  status: 'ok' | 'degraded' | 'unavailable';
  checks: Readonly<Record<string, 'ok' | 'degraded' | 'unavailable'>>;
}

export const NATIVE_AUDIT_ACTIONS = [
  'message.received',
  'message.sent',
  'run.started',
  'run.completed',
  'run.failed',
  'run.interrupted',
  'run.timeout',
  'tool.started',
  'tool.completed',
  'policy.decided',
  'credential.accessed',
  'attachment.read',
  'attachment.written',
  'identity.resolved',
  'chat.resolved',
  'read.performed',
  'admin.action',
] as const;

export type NativeAuditAction = (typeof NATIVE_AUDIT_ACTIONS)[number];

/** Fields common to mutable read-model resources. IDs are Aria-owned and opaque. */
export interface NativeReadResourceBase {
  id: string;
  profileId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  /** Namespaced, optional source details. Core consumers must not depend on them. */
  extensions?: Readonly<Record<string, unknown>>;
}

export interface NativeProfileResource extends NativeReadResourceBase {
  resourceType: 'profile';
  name: string;
  agentKind: string;
  active: boolean;
  runtimeStatus: 'online' | 'offline' | 'degraded';
}

export interface NativeSessionResource extends NativeReadResourceBase {
  resourceType: 'session';
  conversationId: string;
  agentKind: string;
  status: 'active' | 'archived';
  /** Omitted when the native engine does not expose an authoritative start time. */
  startedAt?: string;
  lastActivityAt: string;
  title?: string;
  summary?: string;
  chatId?: string;
  participantIdentityIds: readonly string[];
}

export interface NativeMessageContent {
  available: boolean;
  redacted: boolean;
  format: 'plain-text' | 'markdown' | 'structured' | 'unavailable';
  text?: string;
}

export interface NativeMessageResource extends NativeReadResourceBase {
  resourceType: 'message';
  conversationId: string;
  sessionId?: string;
  runId?: string;
  associationStatus: 'pending' | 'resolved' | 'unavailable';
  sequence: number;
  occurredAt: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  direction: 'inbound' | 'outbound' | 'internal';
  actorIdentityId?: string;
  content: NativeMessageContent;
  attachmentIds: readonly string[];
}

export interface NativeRunResource extends NativeReadResourceBase {
  resourceType: 'run';
  sessionId?: string;
  associationStatus: 'pending' | 'resolved' | 'unavailable';
  status: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'timeout';
  startedAt?: string;
  completedAt?: string;
  terminationReason?: string;
  errorCode?: string;
}

export interface NativeIdentityResource extends NativeReadResourceBase {
  resourceType: 'identity';
  kind: 'user' | 'bot' | 'system' | 'unknown';
  displayName?: string;
  resolutionStatus: NativeReadResolutionStatus;
  resolutionErrorCode?: string;
  lastResolvedAt?: string;
}

export interface NativeChatResource extends NativeReadResourceBase {
  resourceType: 'chat';
  kind: 'p2p' | 'group' | 'topic';
  name?: string;
  ownerIdentityId?: string;
  resolutionStatus: NativeReadResolutionStatus;
  resolutionErrorCode?: string;
  lastResolvedAt?: string;
}

export interface NativeChatMemberResource extends NativeReadResourceBase {
  resourceType: 'chat-member';
  chatId: string;
  identityId: string;
  role: 'owner' | 'admin' | 'member' | 'unknown';
  joinedAt?: string;
  leftAt?: string;
}

export interface NativeAuditActor {
  kind: 'user' | 'bot' | 'system' | 'local-cli' | 'unknown';
  identityId?: string;
}

export interface NativeAuditTarget {
  resourceType: NativeReadResourceType | 'attachment' | 'credential' | 'policy';
  resourceId?: string;
}

/** Append-only governance evidence emitted where the action occurs. */
export interface NativeAuditEventResource extends NativeReadResourceBase {
  resourceType: 'audit-event';
  action: NativeAuditAction;
  occurredAt: string;
  conversationId?: string;
  sessionId?: string;
  runId?: string;
  traceId?: string;
  actor: NativeAuditActor;
  target?: NativeAuditTarget;
  outcome: 'success' | 'failure' | 'denied' | 'unknown';
  errorCode?: string;
  latencyMs?: number;
  redacted: boolean;
}

export type NativeReadResource =
  | NativeProfileResource
  | NativeSessionResource
  | NativeMessageResource
  | NativeRunResource
  | NativeIdentityResource
  | NativeChatResource
  | NativeChatMemberResource
  | NativeAuditEventResource;

export interface NativeReadListResponse<T extends NativeReadResource = NativeReadResource> {
  schema: 'aria.read.list.v1';
  apiVersion: typeof NATIVE_READ_API_VERSION;
  instanceId: string;
  resourceType: T['resourceType'];
  snapshotCursor: NativeReadCursor;
  nextCursor?: NativeReadCursor;
  items: readonly T[];
}

export interface NativeReadDetailResponse<T extends NativeReadResource = NativeReadResource> {
  schema: 'aria.read.detail.v1';
  apiVersion: typeof NATIVE_READ_API_VERSION;
  instanceId: string;
  item: T;
}

export interface NativeReadChange {
  cursor: NativeReadCursor;
  eventId: string;
  changedAt: string;
  operation: 'upsert' | 'delete';
  resourceType: NativeReadResourceType;
  resourceId: string;
  revision: number;
  /** Present for upserts when the caller is authorized to read the resource. */
  resource?: NativeReadResource;
}

export interface NativeReadChangesResponse {
  schema: 'aria.read.changes.v1';
  apiVersion: typeof NATIVE_READ_API_VERSION;
  instanceId: string;
  after: NativeReadCursor | null;
  nextCursor: NativeReadCursor;
  hasMore: boolean;
  changes: readonly NativeReadChange[];
}

export type NativeReadErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CURSOR_INVALID'
  | 'CURSOR_EXPIRED'
  | 'RESOURCE_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export interface NativeReadErrorResponse {
  schema: 'aria.read.error.v1';
  apiVersion: typeof NATIVE_READ_API_VERSION;
  requestId: string;
  error: {
    code: NativeReadErrorCode;
    message: string;
    retryable: boolean;
    resnapshotRequired?: boolean;
  };
}

export const NATIVE_READ_ROUTES = [
  '/v1/meta',
  '/v1/capabilities',
  '/v1/profiles',
  '/v1/sessions',
  '/v1/sessions/{sessionId}',
  '/v1/sessions/{sessionId}/messages',
  '/v1/messages',
  '/v1/runs',
  '/v1/identities',
  '/v1/chats',
  '/v1/chats/{chatId}',
  '/v1/chats/{chatId}/members',
  '/v1/audit/events',
  '/v1/changes',
  '/healthz',
  '/readyz',
] as const;
