import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeReadResourceDraft } from '../../../src/application/control/native-read-repository';
import type { NativeReadResource } from '../../../src/application/control/native-read-types';
import { FileNativeReadRepository } from '../../../src/platform/file-native-read-repository';
import {
  startNativeReadHttpServer,
  type NativeReadHttpServerHandle,
  type NativeReadScope,
} from '../../../src/platform/native-read-http-server';

const roots: string[] = [];
const handles: NativeReadHttpServerHandle[] = [];
afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native read local HTTP server', () => {
  it('requires a bearer token and enforces per-resource scopes', async () => {
    const server = await setup(['read:meta']);

    expect((await get(server.endpoint, '/v1/meta')).status).toBe(401);
    expect((await get(server.endpoint, '/v1/sessions', 'secret')).status).toBe(403);
    const meta = await get(server.endpoint, '/v1/meta', 'secret');
    expect(meta.status).toBe(200);
    expect(meta.body).toMatchObject({ schema: 'aria.read.meta.v1', instanceId: 'instance-1' });
  });

  it('serves normalized lists/details and redacts message content without content scope', async () => {
    const server = await setup(['read:sessions', 'read:messages', 'read:chats']);
    await upsert(server.repository, session());
    await upsert(server.repository, message());
    await upsert(server.repository, chat());

    const sessions = await get(server.endpoint, '/v1/sessions', 'secret');
    const detail = await get(server.endpoint, '/v1/sessions/ses_1', 'secret');
    const messages = await get(server.endpoint, '/v1/sessions/ses_1/messages', 'secret');
    const allMessages = await get(server.endpoint, '/v1/messages', 'secret');

    expect(sessions.body).toMatchObject({ resourceType: 'session', items: [expect.objectContaining({ id: 'ses_1' })] });
    expect(detail.body).toMatchObject({ item: expect.objectContaining({ id: 'ses_1' }) });
    expect(messages.body).toMatchObject({ items: [expect.objectContaining({
      content: { available: false, redacted: true, format: 'unavailable' },
    })] });
    expect(JSON.stringify(messages.body)).not.toContain('private prompt');
    expect(allMessages.body).toMatchObject({ resourceType: 'message', items: [expect.objectContaining({ id: 'msg_1' })] });
  });

  it('returns content only with the dedicated scope and exposes filtered changes', async () => {
    const server = await setup(['read:messages', 'read:message-content', 'read:changes']);
    await upsert(server.repository, message());
    await upsert(server.repository, chat());

    const messages = await get(server.endpoint, '/v1/sessions/ses_1/messages', 'secret');
    const changes = await get(server.endpoint, '/v1/changes?limit=10', 'secret');

    expect(JSON.stringify(messages.body)).toContain('private prompt');
    expect((changes.body as { changes: unknown[] }).changes).toHaveLength(1);
    expect(JSON.stringify(changes.body)).not.toContain('chat_1');
  });

  it('publishes only granted capabilities and creates a mode 0600 socket', async () => {
    const server = await setup(['read:meta', 'read:identities']);
    const response = await get(server.endpoint, '/v1/capabilities', 'secret');
    const ids = (response.body as { capabilities: Array<{ id: string }> }).capabilities.map((item) => item.id);
    expect(ids).toContain('meta');
    expect(ids).toContain('identities.list');
    expect(ids).not.toContain('sessions.list');
    if (process.platform !== 'win32') expect((await stat(server.endpoint)).mode & 0o777).toBe(0o600);
  });

});

async function setup(scopes: NativeReadScope[]) {
  const root = await mkdtemp(join(tmpdir(), 'aria-read-api-'));
  roots.push(root);
  const repository = new FileNativeReadRepository({
    profileId: '***REMOVED***', snapshotFile: join(root, 'snapshot.json'), journalFile: join(root, 'changes.jsonl'),
  });
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\aria-read-api-${randomUUID()}`
    : join(root, 'read.sock');
  const handle = await startNativeReadHttpServer({
    endpoint, token: 'secret', scopes, repository, instanceId: 'instance-1',
    serverVersion: 'test', now: () => new Date('2026-08-27T00:00:00.000Z'),
  });
  handles.push(handle);
  return { endpoint, repository };
}

async function upsert(repository: FileNativeReadRepository, resource: NativeReadResourceDraft) {
  await repository.upsert({ eventId: `event-${resource.id}`, resource });
}

function base<T extends NativeReadResource['resourceType']>(resourceType: T, id: string) {
  return { resourceType, id, profileId: '***REMOVED***', createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:00:00.000Z' };
}
function session(): NativeReadResourceDraft {
  return { ...base('session', 'ses_1'), conversationId: 'cnv_1', agentKind: 'codex', status: 'active',
    lastActivityAt: '2026-08-27T00:00:00.000Z', participantIdentityIds: [] };
}
function message(): NativeReadResourceDraft {
  return { ...base('message', 'msg_1'), conversationId: 'cnv_1', sessionId: 'ses_1',
    associationStatus: 'resolved', sequence: 1,
    occurredAt: '2026-08-27T00:00:00.000Z', role: 'user', direction: 'inbound',
    content: { available: true, redacted: false, format: 'plain-text', text: 'private prompt' }, attachmentIds: [] };
}
function chat(): NativeReadResourceDraft {
  return { ...base('chat', 'chat_1'), kind: 'group', name: 'Team', resolutionStatus: 'resolved' };
}

function get(socketPath: string, path: string, token?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: 'GET', headers: token ? { authorization: `Bearer ${token}` } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.once('error', reject);
    req.end();
  });
}
