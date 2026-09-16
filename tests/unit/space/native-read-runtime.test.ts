import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { PreparedSpaceProfile } from '../../../src/space/profile';
import { SpaceOperationGate } from '../../../src/space/operation-gate';
import { DefaultNativeReadProfileRuntime } from '../../../src/runtime/native-read-runtime';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { SessionCatalog } from '../../../src/session/catalog';
import type { NativeReadRepository } from '../../../src/application/control/native-read-repository';
import { FileNativeReadRepository } from '../../../src/platform/file-native-read-repository';

const cleanups: Array<() => Promise<unknown>> = [];
// This fixture observes on the real clock. No case here asserts that a lease
// expires, so the lease only has to outlive the slowest host the suite runs on;
// a tight one turns a loaded machine into "space binding is stale or suspended".
const OBSERVATION_LEASE_MS = 60 * 60_000;
const managementKeys = generateKeyPairSync('ed25519');
const managementPublicKey = managementKeys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
function managementProof(path: string): string {
  const issued = String(Date.now()), nonce = randomBytes(16).toString('hex');
  const payload = ['aria-management-v1', 'p', 'GET', path, issued, nonce].join('\n');
  return ['aria-management-v1', issued, nonce, sign(null, Buffer.from(payload), managementKeys.privateKey).toString('base64url')].join(':');
}
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aria-space-projection-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ rootDir: root, profile: 'p' });
  const profile = createDefaultProfileConfig({ agentKind: 'claude', mode: 'team',
    accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } } });
  const spaces = await PreparedSpaceProfile.create({ profileId: 'p', profile, directory: join(root, 'prepared'),
    deployment: { engineId: 'claude', binary: process.execPath, binaryVersion: process.version,
      launch: { driver: 'trusted-process', workspaceAccess: 'full', executableRoots: [], environment: {} } } });
  cleanups.push(() => spaces.services.close());
  const source = spaces.services.authorization.registerSource({ profileId: 'p', providerId: 'fixture', accountId: 'bot', instanceId: 'source' });
  const gate = new SpaceOperationGate(spaces.services, { contractVersion: 1, invalidate: () => {},
    observe: async r => source.observe({ conversationId: r.conversationId, actorId: r.senderId, actorKind: r.senderKind,
      kind: r.kind, selfId: 'bot', authenticated: true, complete: true, humans: [r.senderId], agents: ['bot'],
      revision: 1, observedAt: Date.now(), expiresAt: Date.now() + OBSERVATION_LEASE_MS }) }, spaces.grants,
    () => ({ admitted: true, accessCeiling: 'full' }), Date.now, spaces.resources);
  await spaces.registerGate({ pluginId: 'fixture', instanceId: 'source' }, gate);
  const enter = (id: string) => gate.enter({ conversationId: 'dm-' + id, senderId: id, senderKind: 'user', kind: 'direct' }, 'dm-' + id);
  return { root, paths, spaces, gate, a: await enter('a'), b: await enter('b') };
}
it('native messages and run audits use the active source space; controller reads cannot substitute a profile repository', async () => {
  const f = await fixture();
  let selected = f.a;
  let override: NativeReadRepository | undefined;
  const native = new DefaultNativeReadProfileRuntime({ profileId: 'p', appPaths: { ...f.paths, nativeReadEndpoint: join(f.root, 'read.sock') },
    sessionCatalog: new SessionCatalog(join(f.root, 'unused-catalog')), token: 'fixture', scopes: ['read:meta', 'read:messages', 'read:message-content', 'read:changes'],
    serverVersion: 'fixture', spaces: f.spaces,
    spaceRepository: async () => {
      if (override) return override;
      await f.gate.refresh(selected);
      return f.spaces.reads.repository(selected.context);
    } });
  await native.start(); cleanups.push(() => native.stop());
  await expect(native.messageRead.observe(event('a'))).rejects.toThrow('authenticated source');
  await Promise.all([f.a, f.b].map(operation => f.gate.run(operation, async () => {
    await native.messageRead.observe(event(operation.request.senderId));
    await native.runAudit.record({ eventId: operation.scopeRef + ':run', sourceRunId: operation.scopeRef,
      action: 'run.started', outcome: 'success', occurredAt: new Date().toISOString() });
  })));
  const ra = await f.spaces.reads.repository(f.a.context), rb = await f.spaces.reads.repository(f.b.context);
  expect(JSON.stringify(await ra.list('message'))).toContain('private a');
  expect(JSON.stringify(await ra.list('message'))).not.toContain('private b');
  expect(await rb.list('run')).toHaveLength(1);
  const endpoint = join(f.root, 'read.sock');
  expect((await get(endpoint, '/v1/messages')).body).toContain('private a');
  selected = f.b;
  expect((await get(endpoint, '/v1/messages')).body).not.toContain('private a');
  override = new FileNativeReadRepository({ profileId: 'p', snapshotFile: join(f.root, 'ambient.json'), journalFile: join(f.root, 'ambient.jsonl') });
  expect((await get(endpoint, '/v1/messages')).status).toBe(403);
  expect((await get(endpoint, '/healthz')).status).toBe(200);
});
it('an existing profile-wide token retains health access but grants no prepared private history', async () => {
  const f = await fixture();
  const endpoint = join(f.root, 'read.sock');
  const native = new DefaultNativeReadProfileRuntime({ profileId: 'p', appPaths: { ...f.paths, nativeReadEndpoint: endpoint },
    sessionCatalog: new SessionCatalog(join(f.root, 'unused')), token: 'fixture',
    scopes: ['read:meta', 'read:messages', 'read:sessions'], serverVersion: 'fixture', spaces: f.spaces });
  await native.start(); cleanups.push(() => native.stop());
  expect((await get(endpoint, '/readyz')).status).toBe(200);
  expect((await get(endpoint, '/v1/messages')).status).toBe(403);
  expect((await get(endpoint, '/v1/sessions')).status).toBe(403);
  await f.gate.run(f.a, () => native.messageRead.observe(event('a')));
  const delegated = await f.spaces.readAccess.issue(f.gate, f.a);
  const other = await f.spaces.readAccess.issue(f.gate, f.b);
  const own = JSON.parse((await get(endpoint, '/v1/messages', delegated.token)).body);
  expect(own.items).toHaveLength(1);
  expect(own.items[0].content).toMatchObject({ redacted: true, available: false });
  expect(JSON.parse((await get(endpoint, '/v1/messages', other.token)).body).items).toHaveLength(0);
  await f.spaces.readAccess.revoke(delegated.token);
  expect((await get(endpoint, '/v1/messages', delegated.token)).status).toBe(403);
});
function event(id: string) {
  return { eventId: 'inbound-' + id, sourceMessageId: 'message-' + id, conversationKey: 'dm-' + id,
    actorSourceId: id, direction: 'inbound' as const, occurredAt: new Date().toISOString(),
    content: { format: 'plain-text' as const, text: 'private ' + id } };
}
function get(socketPath: string, path: string, token?: string, management?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, headers: { authorization: 'Bearer fixture', ...(token ? { 'x-aria-space-read-token': token } : {}), ...(management ? { 'x-aria-management-authorization': management === 'management-fixture' ? managementProof(path) : management } : {}) } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end();
  });
}

it('management reads observe both Spaces and sealed legacy without granting an agent cross-Space reads', async () => {
  const f = await fixture(); const endpoint = join(f.root, 'read.sock');
  const legacy = new FileNativeReadRepository({ profileId: 'p', snapshotFile: f.paths.nativeReadSnapshotFile, journalFile: f.paths.nativeReadJournalFile });
  const time = (n: number) => `2026-09-08T08:00:0${n}.000Z`;
  await legacy.upsert({ eventId: 'old-session', resource: { resourceType: 'session', id: 'old', profileId: 'p',
    conversationId: 'old-chat', agentKind: 'codex', status: 'archived', createdAt: time(0), updatedAt: time(0),
    lastActivityAt: time(0), participantIdentityIds: [] } });
  const native = new DefaultNativeReadProfileRuntime({ profileId: 'p', appPaths: { ...f.paths, nativeReadEndpoint: endpoint },
    sessionCatalog: new SessionCatalog(join(f.root, 'unused')), token: 'fixture', managementPublicKey,
    scopes: ['read:meta', 'read:sessions', 'read:messages', 'read:message-content', 'read:identities', 'read:chats', 'read:runs'],
    serverVersion: 'fixture', spaces: f.spaces });
  await native.start(); cleanups.push(() => native.stop());
  for (const [i, operation] of [f.a, f.b].entries()) await f.gate.run(operation, async () => {
    const id = operation.request.senderId;
    await native.messageRead.observe({ ...event(id), occurredAt: time(i + 1), actorDisplayName: `Human ${id}`, conversationKind: 'group', conversationName: `Group ${id}` });
    await native.messageRead.bind({ bindingId: id, correlationId: id, conversationKey: 'dm-' + id,
      sourceRunId: id, agentKind: 'codex', sourceSessionId: id, sourceMessageIds: ['message-' + id], occurredAt: time(i + 1) });
  });
  expect((await get(endpoint, '/v1/session-summaries')).status).toBe(403);
  expect((await get(endpoint, '/v1/session-summaries', undefined, 'fixture')).status).toBe(403);
  await expect.poll(async () => (await get(endpoint, '/readyz', undefined, 'management-fixture')).status).toBe(200);
  const response = JSON.parse((await get(endpoint, '/v1/session-summaries?limit=1', undefined, 'management-fixture')).body);
  expect(response.total).toBe(3);
  expect(response.items[0].lastUser.displayName).toBe('Human b');
  expect(response.items[0].chat.name).toBe('Group b');
  const next = JSON.parse((await get(endpoint, '/v1/session-summaries?limit=200&cursor=' + response.nextCursor, undefined, 'management-fixture')).body);
  expect(next.items).toHaveLength(2);
  expect(next.items[1].session.extensions['aria.management.origin'].kind).toBe('legacy');
  const own = await f.spaces.reads.repository(f.a.context);
  expect(JSON.stringify(await own.list('message'))).not.toContain('private b');
  expect((await own.list('session')).some(x => x.id === 'old')).toBe(false);
  expect((await legacy.list('session'))).toHaveLength(1);
  const access = await f.spaces.readAccess.issue(f.gate, f.a);
  expect((await get(endpoint, '/v1/messages', access.token, 'management-fixture')).status).toBe(403);
  const caps = JSON.parse((await get(endpoint, '/v1/capabilities', undefined, 'management-fixture')).body);
  expect(caps.capabilities.some((c: { route: string }) => c.route === '/v1/session-summaries')).toBe(true);
  const ordinary = JSON.parse((await get(endpoint, '/v1/capabilities')).body);
  expect(ordinary.capabilities.some((c: { route: string }) => c.route === '/v1/session-summaries')).toBe(false);
});
it('management-index failure does not reject intake or stop a running Space', async () => {
  const f = await fixture(); const endpoint = join(f.root, 'read.sock');
  const control = join(f.spaces.stateDirectory, 'space-control'); await mkdir(control, { recursive: true });
  await writeFile(join(control, 'management-read'), 'not a directory');
  const native = new DefaultNativeReadProfileRuntime({ profileId:'p', appPaths:{ ...f.paths,nativeReadEndpoint:endpoint },
    sessionCatalog:new SessionCatalog(join(f.root,'unused')), token:'fixture', managementPublicKey,
    scopes:['read:meta','read:sessions','read:messages'], serverVersion:'fixture', spaces:f.spaces });
  await native.start(); cleanups.push(()=>native.stop());
  await f.gate.run(f.a,()=>native.messageRead.observe(event('a')));
  expect(await (await f.spaces.reads.repository(f.a.context)).list('message')).toHaveLength(1);
  expect((await get(endpoint,'/readyz')).status).toBe(200);
  expect((await get(endpoint,'/v1/sessions',undefined,'management-fixture')).status).toBe(503);
});
