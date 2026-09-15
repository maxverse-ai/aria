import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { gateFixture, directRequest } from '../../helpers/space-gate';
import { SpaceNativeRead } from '../../../src/space/native-read';
import { startNativeReadHttpServer } from '../../../src/platform/native-read-http-server';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
it('D1: real Native Read HTTP and cursors stay in the authenticated space and epoch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-space-read-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const f = await gateFixture(root); cleanups.push(() => f.services.close());
  const a = await f.gate.enter(directRequest(), 'dm-a');
  const b = await f.gate.enter(directRequest('b'), 'dm-b');
  const reads = new SpaceNativeRead(f.services);
  const ra = await reads.repository(a.context); const rb = await reads.repository(b.context);
  const date = '2026-09-07T00:00:00Z';
  await ra.upsert({ eventId: 'one', resource: { resourceType: 'chat', id: 'private-a', profileId: 'profile',
    kind: 'p2p', name: 'A private', resolutionStatus: 'resolved', createdAt: date, updatedAt: date } });
  expect(await rb.get('chat', 'private-a')).toBeUndefined();
  expect(await rb.list('chat')).toEqual([]);
  const cursor = await ra.currentCursor();
  await expect(rb.changes(cursor)).rejects.toThrow('another space binding');
  const page = await ra.changes(null); expect(page.changes[0]?.cursor).toBe(cursor);
  expect((await ra.changes(page.nextCursor)).changes).toEqual([]);
  let selected = a;
  const endpoint = join(root, 'read.sock');
  const server = await startNativeReadHttpServer({ endpoint, token: 'fixture-token', scopes: ['read:chats', 'read:changes'],
    repository: ra, instanceId: 'fixture', serverVersion: 'test',
    spaceRepository: async () => { await f.gate.refresh(selected); return reads.repository(selected.context); } });
  cleanups.push(() => server.close());
  expect((await get(endpoint, '/v1/chats')).body).toMatchObject({ items: [expect.objectContaining({ id: 'private-a' })] });
  selected = b;
  expect((await get(endpoint, '/v1/chats')).body).toMatchObject({ items: [] });
  expect((await get(endpoint, '/v1/chats/private-a')).status).toBe(404);
  f.state.admitted = false;
  expect((await get(endpoint, '/v1/chats')).status).toBe(403);
  await expect(rb.list('chat')).rejects.toThrow();
});
function get(socketPath: string, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, headers: { authorization: 'Bearer fixture-token' } }, (res) => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    }); req.on('error', reject); req.end();
  });
}

it('ordinary groups reuse a space but keep native reads, cursors and history inside the original conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-shared-read-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const f = await gateFixture(root); cleanups.push(() => f.services.close());
  f.state.humans = ['a', 'b'];
  const a = await f.gate.enter({ ...directRequest('a', 'group-one'), kind: 'group' }, 'group-one');
  const b = await f.gate.enter({ ...directRequest('b', 'group-two'), kind: 'group' }, 'group-two');
  expect(f.authorization.inspect(a.context).binding.spaceId).toBe(f.authorization.inspect(b.context).binding.spaceId);
  const reads = new SpaceNativeRead(f.services);
  const ra = await reads.repository(a.context), rb = await reads.repository(b.context);
  const date = new Date().toISOString();
  await ra.upsert({ eventId: 'group-one', resource: { resourceType: 'chat', id: 'group-one', profileId: 'profile',
    kind: 'group', name: 'Group one', resolutionStatus: 'resolved', createdAt: date, updatedAt: date } });
  expect(await rb.list('chat')).toEqual([]);
  await expect(rb.changes(await ra.currentCursor())).rejects.toThrow('another space binding');
  const state = await f.services.state.view(a.context);
  state.sessionCatalog.upsertActive({ scopeId: a.executionScope, agentId: 'claude', cwdRealpath: state.paths.workspace,
    policyFingerprint: 'a', sessionId: 'native-a', now: 1 });
  state.sessionCatalog.upsertActive({ scopeId: b.executionScope, agentId: 'claude', cwdRealpath: state.paths.workspace,
    policyFingerprint: 'b', sessionId: 'native-b', now: 2 });
  expect((await f.services.history(a.context, state.paths.workspace, 10)).map(item => item.id)).toEqual(['native-a']);
  expect((await f.services.history(b.context, state.paths.workspace, 10)).map(item => item.id)).toEqual(['native-b']);
  expect(await (await reads.repository(a.context)).list('session')).toHaveLength(1);
  f.state.humans = ['a', 'b', 'c'];
  const changed = await f.gate.enter({ ...directRequest('c', 'group-one'), kind: 'group' }, 'group-one');
  expect(await (await reads.repository(changed.context)).list('chat')).toEqual([]);
  await expect(ra.list('chat')).rejects.toThrow();
});
