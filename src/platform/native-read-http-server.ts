import { randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import type { NativeReadRepository } from '../application/control/native-read-repository';
import { NativeReadRepositoryError } from '../application/control/native-read-repository';
import {
  NATIVE_READ_API_VERSION,
  type NativeReadCapability,
  type NativeReadErrorCode,
  type NativeReadResource,
  type NativeReadResourceType,
} from '../application/control/native-read-types';

export type NativeReadScope =
  | 'read:meta'
  | 'read:profiles'
  | 'read:sessions'
  | 'read:messages'
  | 'read:message-content'
  | 'read:runs'
  | 'read:identities'
  | 'read:chats'
  | 'read:audit'
  | 'read:changes';

export interface NativeReadHttpServerOptions {
  endpoint: string;
  token: string;
  scopes: readonly NativeReadScope[];
  repository: NativeReadRepository;
  instanceId?: string;
  serverVersion: string;
  now?: () => Date;
}

export interface NativeReadHttpServerHandle {
  readonly endpoint: string;
  readonly instanceId: string;
  close(): Promise<void>;
}

export async function startNativeReadHttpServer(
  options: NativeReadHttpServerOptions,
): Promise<NativeReadHttpServerHandle> {
  if (!options.token) throw new Error('native read API token is required');
  await options.repository.initialize();
  const instanceId = options.instanceId ?? randomUUID();
  const startedAt = (options.now ?? (() => new Date()))().toISOString();
  if (process.platform !== 'win32') {
    await mkdir(dirname(options.endpoint), { recursive: true, mode: 0o700 });
    await rm(options.endpoint, { force: true });
  }
  const server = createServer((request, response) => {
    handleRequest(request, response, options, instanceId, startedAt).catch(() => {
      if (!response.headersSent) sendError(response, 500, 'INTERNAL_ERROR', 'internal error');
      else response.end();
    });
  });
  await listen(server, options.endpoint);
  if (process.platform !== 'win32') await chmod(options.endpoint, 0o600);
  return {
    endpoint: options.endpoint,
    instanceId,
    async close() {
      await close(server);
      if (process.platform !== 'win32') await rm(options.endpoint, { force: true });
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: NativeReadHttpServerOptions,
  instanceId: string,
  startedAt: string,
): Promise<void> {
  if (!validBearer(request.headers.authorization, options.token)) {
    sendError(response, 401, 'UNAUTHORIZED', 'invalid bearer token');
    return;
  }
  if (request.method !== 'GET') {
    sendError(response, 400, 'INVALID_REQUEST', 'only GET is supported');
    return;
  }
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const context = { options, response, instanceId };

  if (path === '/healthz' || path === '/readyz') {
    sendJson(response, 200, {
      schema: 'aria.read.health.v1', apiVersion: NATIVE_READ_API_VERSION,
      status: 'ok', checks: { repository: 'ok', transport: 'ok' },
    });
    return;
  }
  if (path === '/v1/meta') {
    if (!requireScope(context, 'read:meta')) return;
    sendJson(response, 200, {
      schema: 'aria.read.meta.v1', apiVersion: NATIVE_READ_API_VERSION,
      instanceId, serverVersion: options.serverVersion, startedAt,
    });
    return;
  }
  if (path === '/v1/capabilities') {
    if (!requireScope(context, 'read:meta')) return;
    sendJson(response, 200, {
      schema: 'aria.read.capabilities.v1', apiVersion: NATIVE_READ_API_VERSION,
      instanceId, capabilities: capabilities(options.scopes),
    });
    return;
  }
  if (path === '/v1/changes') {
    if (!requireScope(context, 'read:changes')) return;
    const after = url.searchParams.get('after');
    const limit = parseLimit(url.searchParams.get('limit'));
    if (limit === undefined) {
      sendError(response, 400, 'INVALID_REQUEST', 'invalid limit');
      return;
    }
    try {
      const page = await options.repository.changes(after, limit);
      const permitted = page.changes
        .filter((change) => hasScope(options.scopes, scopeFor(change.resourceType)))
        .map((change) => change.resource ? { ...change, resource: protectMessageContent(change.resource, options.scopes) } : change);
      sendJson(response, 200, {
        schema: 'aria.read.changes.v1', apiVersion: NATIVE_READ_API_VERSION,
        instanceId, after, nextCursor: page.nextCursor, hasMore: page.hasMore, changes: permitted,
      });
    } catch (error) {
      sendRepositoryError(response, error);
    }
    return;
  }

  const route = matchResourceRoute(path);
  if (!route) {
    sendError(response, 404, 'NOT_FOUND', 'route not found');
    return;
  }
  if (!requireScope(context, scopeFor(route.resourceType))) return;
  const items = await options.repository.list(route.resourceType);
  const filtered = items.filter(route.filter).map((item) => protectMessageContent(item, options.scopes));
  if (route.resourceType === 'message') {
    filtered.sort((left, right) => left.resourceType === 'message' && right.resourceType === 'message'
      ? left.occurredAt.localeCompare(right.occurredAt) || left.sequence - right.sequence || left.id.localeCompare(right.id)
      : 0);
  }
  if (route.detailId) {
    const item = filtered.find((candidate) => candidate.id === route.detailId);
    if (!item) sendError(response, 404, 'NOT_FOUND', 'resource not found');
    else sendJson(response, 200, {
      schema: 'aria.read.detail.v1', apiVersion: NATIVE_READ_API_VERSION, instanceId, item,
    });
    return;
  }
  sendJson(response, 200, {
    schema: 'aria.read.list.v1', apiVersion: NATIVE_READ_API_VERSION, instanceId,
    resourceType: route.resourceType, snapshotCursor: await options.repository.currentCursor(), items: filtered,
  });
}

interface MatchedRoute {
  resourceType: NativeReadResourceType;
  detailId?: string;
  filter(resource: NativeReadResource): boolean;
}

function matchResourceRoute(path: string): MatchedRoute | undefined {
  const all = (resourceType: NativeReadResourceType): MatchedRoute => ({ resourceType, filter: () => true });
  const lists: Record<string, NativeReadResourceType> = {
    '/v1/profiles': 'profile', '/v1/sessions': 'session', '/v1/runs': 'run',
    '/v1/messages': 'message',
    '/v1/identities': 'identity', '/v1/chats': 'chat', '/v1/audit/events': 'audit-event',
  };
  if (lists[path]) return all(lists[path]);
  let match = /^\/v1\/sessions\/([^/]+)$/.exec(path);
  if (match?.[1]) return { ...all('session'), detailId: decodeURIComponent(match[1]) };
  match = /^\/v1\/chats\/([^/]+)$/.exec(path);
  if (match?.[1]) return { ...all('chat'), detailId: decodeURIComponent(match[1]) };
  match = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(path);
  if (match?.[1]) {
    const sessionId = decodeURIComponent(match[1]);
    return { resourceType: 'message', filter: (item) => item.resourceType === 'message' && item.sessionId === sessionId };
  }
  match = /^\/v1\/chats\/([^/]+)\/members$/.exec(path);
  if (match?.[1]) {
    const chatId = decodeURIComponent(match[1]);
    return { resourceType: 'chat-member', filter: (item) => item.resourceType === 'chat-member' && item.chatId === chatId };
  }
  return undefined;
}

function protectMessageContent(resource: NativeReadResource, scopes: readonly NativeReadScope[]): NativeReadResource {
  if (resource.resourceType !== 'message' || hasScope(scopes, 'read:message-content')) return resource;
  return { ...resource, content: { available: false, redacted: true, format: 'unavailable' } };
}

function scopeFor(type: NativeReadResourceType): NativeReadScope {
  return ({ profile: 'read:profiles', session: 'read:sessions', message: 'read:messages', run: 'read:runs',
    identity: 'read:identities', chat: 'read:chats', 'chat-member': 'read:chats', 'audit-event': 'read:audit' } as const)[type];
}

function capabilities(scopes: readonly NativeReadScope[]): NativeReadCapability[] {
  const definitions: NativeReadCapability[] = [
    { id: 'meta', method: 'GET', route: '/v1/meta', requiredScopes: ['read:meta'] },
    { id: 'capabilities', method: 'GET', route: '/v1/capabilities', requiredScopes: ['read:meta'] },
    { id: 'health', method: 'GET', route: '/healthz', requiredScopes: [] },
    { id: 'readiness', method: 'GET', route: '/readyz', requiredScopes: [] },
    { id: 'profiles.list', method: 'GET', route: '/v1/profiles', requiredScopes: ['read:profiles'], resourceType: 'profile' },
    { id: 'sessions.list', method: 'GET', route: '/v1/sessions', requiredScopes: ['read:sessions'], resourceType: 'session' },
    { id: 'sessions.get', method: 'GET', route: '/v1/sessions/{sessionId}', requiredScopes: ['read:sessions'], resourceType: 'session' },
    { id: 'messages.list', method: 'GET', route: '/v1/sessions/{sessionId}/messages', requiredScopes: ['read:messages'], resourceType: 'message' },
    { id: 'messages.list-all', method: 'GET', route: '/v1/messages', requiredScopes: ['read:messages'], resourceType: 'message' },
    { id: 'runs.list', method: 'GET', route: '/v1/runs', requiredScopes: ['read:runs'], resourceType: 'run' },
    { id: 'identities.list', method: 'GET', route: '/v1/identities', requiredScopes: ['read:identities'], resourceType: 'identity' },
    { id: 'chats.list', method: 'GET', route: '/v1/chats', requiredScopes: ['read:chats'], resourceType: 'chat' },
    { id: 'chats.get', method: 'GET', route: '/v1/chats/{chatId}', requiredScopes: ['read:chats'], resourceType: 'chat' },
    { id: 'chat-members.list', method: 'GET', route: '/v1/chats/{chatId}/members', requiredScopes: ['read:chats'], resourceType: 'chat-member' },
    { id: 'audit.list', method: 'GET', route: '/v1/audit/events', requiredScopes: ['read:audit'], resourceType: 'audit-event' },
    { id: 'changes.list', method: 'GET', route: '/v1/changes', requiredScopes: ['read:changes'] },
  ];
  return definitions.filter((item) => item.requiredScopes.every((scope) => hasScope(scopes, scope as NativeReadScope)));
}

function requireScope(context: { options: NativeReadHttpServerOptions; response: ServerResponse }, scope: NativeReadScope): boolean {
  if (hasScope(context.options.scopes, scope)) return true;
  sendError(context.response, 403, 'FORBIDDEN', `missing scope ${scope}`);
  return false;
}

function hasScope(scopes: readonly NativeReadScope[], scope: NativeReadScope): boolean { return scopes.includes(scope); }
function parseLimit(value: string | null): number | undefined {
  if (value === null) return 100;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1000 ? parsed : undefined;
}
function validBearer(header: string | undefined, token: string): boolean {
  const provided = header?.startsWith('Bearer ') ? header.slice(7) : '';
  return provided.length === token.length && timingSafeEqual(Buffer.from(provided), Buffer.from(token));
}
function sendRepositoryError(response: ServerResponse, error: unknown): void {
  if (error instanceof NativeReadRepositoryError && (error.code === 'CURSOR_INVALID' || error.code === 'PROFILE_MISMATCH')) {
    sendError(response, 400, 'CURSOR_INVALID', 'invalid cursor');
  } else sendError(response, 500, 'RESOURCE_UNAVAILABLE', 'repository unavailable', true);
}
function sendError(response: ServerResponse, status: number, code: NativeReadErrorCode, message: string, retryable = false): void {
  sendJson(response, status, { schema: 'aria.read.error.v1', apiVersion: NATIVE_READ_API_VERSION,
    requestId: randomUUID(), error: { code, message, retryable } });
}
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`${JSON.stringify(body)}\n`);
}
function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.off('error', onError);
      resolve();
    });
  });
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}
