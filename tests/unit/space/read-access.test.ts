import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { PreparedSpaceProfile } from '../../../src/space/profile';
import { SpaceOperationGate } from '../../../src/space/operation-gate';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { runtimeProbeVersion } from '../../helpers/runtime';

// This fixture observes on the real clock. No case here asserts that a lease
// expires, so the lease only has to outlive the slowest host the suite runs on;
// a tight one turns a loaded machine into "space binding is stale or suspended".
const OBSERVATION_LEASE_MS = 60 * 60_000;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(directory?: string) {
  const root = directory ?? await mkdtemp(join(tmpdir(), 'aria-read-access-'));
  if (!directory) cleanups.push(() => rm(root, { recursive: true, force: true }));
  const profile = createDefaultProfileConfig({ agentKind: 'claude', mode: 'team',
    accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } } });
  const spaces = await PreparedSpaceProfile.create({ profileId: 'p', profile, directory: root,
    deployment: { engineId: 'claude', binary: process.execPath, binaryVersion: runtimeProbeVersion,
      launch: { driver: 'trusted-process', workspaceAccess: 'workspace', executableRoots: [], environment: {} } } });
  cleanups.push(() => spaces.services.close());
  const source = spaces.services.authorization.registerSource({ profileId: 'p', providerId: 'fixture', accountId: 'account', instanceId: 'source' });
  let admitted = true;
  let shared = false;
  let revision = 100;
  const gate = new SpaceOperationGate(spaces.services, { contractVersion: 1, invalidate: () => {},
    observe: async request => source.observe({ conversationId: request.conversationId, actorId: request.senderId,
      actorKind: request.senderKind, kind: request.kind, selfId: 'bot', authenticated: true, complete: true,
      humans: shared && request.kind === 'group' ? ['a', 'b'] : [request.senderId], agents: ['bot'],
      revision: ++revision, observedAt: Date.now(), expiresAt: Date.now() + OBSERVATION_LEASE_MS }) }, spaces.grants,
    () => ({ admitted, accessCeiling: 'workspace' }), Date.now, spaces.resources);
  await spaces.registerGate({ pluginId: 'fixture', instanceId: 'source' }, gate);
  const enter = (user: string, group = false) => gate.enter({ conversationId: (group ? 'group-' : 'dm-') + user,
    senderId: user, senderKind: 'user', kind: group ? 'group' : 'direct' }, (group ? 'group-' : 'dm-') + user);
  return { root, spaces, gate, enter, deny: () => { admitted = false; }, share: () => { shared = true; },
    afterRestart: () => { revision = 10_000; } };
}

it('delegated readers retain the source, deny writes and foreign cursors, and persist only token hashes', async () => {
  const f = await fixture();
  const a = await f.enter('a'), b = await f.enter('b');
  const [ra, rb] = await Promise.all([f.spaces.reads.repository(a.context), f.spaces.reads.repository(b.context)]);
  const [aKey, bKey] = await Promise.all([f.spaces.readAccess.issue(f.gate, a), f.spaces.readAccess.issue(f.gate, b)]);
  const time = new Date().toISOString();
  await ra.upsert({ eventId: 'owned-a', resource: { resourceType: 'profile', id: 'owned-a', profileId: 'p',
    createdAt: time, updatedAt: time, name: 'A', active: true, runtimeStatus: 'online', agentKind: 'claude' } });
  expect(await (await f.spaces.readAccess.repository(aKey.token)).list('profile')).toHaveLength(1);
  expect(await (await f.spaces.readAccess.repository(bKey.token)).list('profile')).toHaveLength(0);
  const reader = await f.spaces.readAccess.repository(aKey.token);
  f.spaces.reads.assertRepository(reader);
  await expect(reader.changes(await rb.currentCursor(), 10)).rejects.toThrow('another space');
  await expect(reader.delete({ eventId: 'delete', resourceType: 'profile', resourceId: 'owned-a' })).rejects.toThrow('cannot write');
  const persisted = await readFile(join(f.root, 'space-control', 'read-access.v1.json'), 'utf8');
  expect(persisted).not.toContain(aKey.token);
  expect(persisted).not.toContain(bKey.token);
  await f.spaces.readAccess.revoke(aKey.token);
  await expect(reader.list('profile')).rejects.toThrow('revoked');
  expect(await (await f.spaces.readAccess.repository(bKey.token)).list('profile')).toHaveLength(0);
});

it('a retained read token survives restart only after fresh source admission; membership changes retire it', async () => {
  const f = await fixture();
  const operation = await f.enter('a', true);
  const key = await f.spaces.readAccess.issue(f.gate, operation);
  await f.spaces.services.close();
  const restarted = await fixture(f.root);
  restarted.afterRestart();
  const reader = await restarted.spaces.readAccess.repository(key.token);
  expect(await reader.list('message')).toEqual([]);
  restarted.share();
  await expect(reader.list('message')).rejects.toThrow('audience changed');
  await expect(restarted.spaces.readAccess.repository(key.token)).rejects.toThrow('audience changed');
});

it('read access cannot be issued for a foreign profile and source revocation is checked on every read', async () => {
  const f = await fixture(), foreign = await fixture();
  const operation = await f.enter('a');
  await expect(foreign.spaces.readAccess.issue(f.gate, operation)).rejects.toThrow('delegation');
  const key = await f.spaces.readAccess.issue(f.gate, operation);
  const reader = await f.spaces.readAccess.repository(key.token);
  f.deny();
  await expect(reader.list('message')).rejects.toThrow('access-denied');
  await expect(f.spaces.readAccess.repository('0'.repeat(64))).rejects.toThrow('revoked');
});


it('a DM can delegate a verified group audience without exposing the private owner space', async () => {
  const f = await fixture();
  const dm = await f.enter('a');
  f.share();
  const group = await f.enter('a', true);
  const key = await f.spaces.readAccess.issueFromDirect(f.gate, dm, 'group-a');
  const own = await f.spaces.reads.repository(dm.context);
  const time = new Date().toISOString();
  await own.upsert({ eventId: 'personal-only', resource: { resourceType: 'profile', id: 'personal-only', profileId: 'p',
    createdAt: time, updatedAt: time, name: 'Private', active: true, runtimeStatus: 'online', agentKind: 'claude' } });
  expect(await (await f.spaces.readAccess.repository(key.token)).list('profile')).toEqual([]);
  await expect(f.spaces.readAccess.issueFromDirect(f.gate, group)).rejects.toThrow('real private');
  f.deny();
  await expect(f.spaces.readAccess.issueFromDirect(f.gate, dm, 'foreign-group')).rejects.toThrow('access-denied');
});
