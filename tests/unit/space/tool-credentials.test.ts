import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { fixture, authorize } from './helpers';
import { SpaceToolIdentity } from '../../../src/space/grants';
import { SpaceToolCredentials, type SpaceToolCredentialProvider } from '../../../src/space/tool-credentials';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const signal = () => new AbortController().signal;
async function setup() {
  const f = fixture();
  const root = await mkdtemp(join(tmpdir(), 'aria-tool-identity-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'tool-identity.json');
  const a = await authorize(f), b = await authorize(f, { conversationId: 'dm-b', actorId: 'b', humans: ['b'] });
  const solo = await authorize(f, { kind: 'group', conversationId: 'solo' });
  const shared = await authorize(f, { kind: 'group', conversationId: 'shared', humans: ['a', 'b'] });
  const returnedA = await authorize(f, { revision: 2 });
  const returnedB = await authorize(f, { conversationId: 'dm-b', actorId: 'b', humans: ['b'], revision: 2 });
  const provider: SpaceToolCredentialProvider = {
    id: 'fixture', authorityId: f.source.authorityId,
    begin: vi.fn(async () => ({ verificationUrl: 'https://auth.example/verify', expiresAt: 5000 })),
    complete: vi.fn(async input => ({ principal: input.context.principal,
      credentialRef: 'provider-owned-' + input.context.principal.subjectId })),
    cancel: vi.fn(async () => {}), revoke: vi.fn(async () => {}),
    invoke: vi.fn(async input => ({ stdout: input.identity, stderr: '', exitCode: 0 })),
  };
  const identity = new SpaceToolIdentity(f.authorization, () => 1000, file);
  const tools = new SpaceToolCredentials(f.authorization, identity, () => 1000);
  tools.register(provider);
  return { ...f, root, file, a, b, returnedA, returnedB, solo, shared, provider, identity, tools };
}

it('private authorization survives restart, rejects foreign completion, and never starts OAuth in a solo or shared group', async () => {
  const f = await setup();
  await expect(f.tools.begin(f.solo, 'fixture', ['docs:read'], signal())).rejects.toThrow('direct');
  await expect(f.tools.begin(f.shared, 'fixture', ['docs:read'], signal())).rejects.toThrow('direct');
  expect(f.provider.begin).not.toHaveBeenCalled();
  const [a, b] = await Promise.all([f.tools.begin(f.a, 'fixture', ['docs:read'], signal()), f.tools.begin(f.b, 'fixture', ['docs:read'], signal())]);
  await expect(f.tools.complete(f.a, 'fixture', a.transactionId, signal())).rejects.toThrow('later user request');
  await expect(f.tools.complete(f.b, 'fixture', a.transactionId, signal())).rejects.toThrow('private transaction');
  expect(f.provider.complete).not.toHaveBeenCalled();
  const identity = new SpaceToolIdentity(f.authorization, () => 1000, f.file);
  await identity.load();
  const restarted = new SpaceToolCredentials(f.authorization, identity, () => 1000);
  restarted.register(f.provider);
  const [ag, bg] = await Promise.all([restarted.complete(f.returnedA, 'fixture', a.transactionId, signal()), restarted.complete(f.returnedB, 'fixture', b.transactionId, signal())]);
  expect(identity.resolve(f.solo, ag.ref).credentialRef).toBe('provider-owned-a');
  expect(() => identity.resolve(f.b, ag.ref)).toThrow('unavailable');
  expect(() => identity.resolve(f.shared, ag.ref)).toThrow('unavailable');
  expect(identity.find(f.shared, 'fixture')).toBeUndefined();
  expect(identity.resolve(f.b, bg.ref).credentialRef).toBe('provider-owned-b');
  await expect(restarted.complete(f.a, 'fixture', a.transactionId, signal())).rejects.toThrow('private transaction');
  const afterRestart = new SpaceToolIdentity(f.authorization, () => 1000, f.file);
  await afterRestart.load();
  expect(afterRestart.resolve(f.a, ag.ref).credentialRef).toBe('provider-owned-a');
});

it('the actual provider subject must match the initiator; wrong-user credentials are revoked and never activated', async () => {
  const f = await setup();
  vi.mocked(f.provider.complete).mockImplementationOnce(async () => ({ principal: f.authorization.inspect(f.b).principal,
    credentialRef: 'wrong-account' }));
  const start = await f.tools.begin(f.a, 'fixture', ['docs:read'], signal());
  await expect(f.tools.complete(f.returnedA, 'fixture', start.transactionId, signal())).rejects.toThrow('authorizing user');
  expect(f.provider.revoke).toHaveBeenCalledWith('wrong-account');
  expect(f.identity.find(f.a, 'fixture')).toBeUndefined();
  expect(await readFile(f.file, 'utf8')).not.toContain('wrong-account');
});

it('revocation is durable before provider cleanup; a failed cleanup cannot restore use or expose an in-flight private result', async () => {
  const f = await setup();
  const start = await f.tools.begin(f.a, 'fixture', ['docs:read'], signal());
  const grant = await f.tools.complete(f.returnedA, 'fixture', start.transactionId, signal());
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  vi.mocked(f.provider.invoke).mockImplementationOnce(async () => { await waiting; return { stdout: 'private result', stderr: '', exitCode: 0 }; });
  const result = f.tools.invoke(f.a, 'fixture', { argv: ['docs', 'list'], cwd: f.root, identity: 'user', signal: signal() });
  await vi.waitFor(() => expect(f.provider.invoke).toHaveBeenCalledTimes(1));
  vi.mocked(f.provider.revoke).mockRejectedValueOnce(new Error('provider offline'));
  await expect(f.tools.revoke(f.a, 'fixture')).rejects.toThrow('provider offline');
  release();
  await expect(result).rejects.toThrow('unavailable');
  const restarted = new SpaceToolIdentity(f.authorization, () => 1000, f.file);
  await restarted.load();
  expect(() => restarted.resolve(f.a, grant.ref)).toThrow('unavailable');
  await expect(f.tools.invoke(f.a, 'fixture', { argv: ['docs', 'list'], cwd: f.root, identity: 'user', signal: signal() })).rejects.toThrow('authorization');
});

it('shared tool calls use the bot without personal credentials; cancelling one pending user flow leaves the other intact', async () => {
  const f = await setup();
  const [a, b] = await Promise.all([f.tools.begin(f.a, 'fixture', ['docs:read'], signal()), f.tools.begin(f.b, 'fixture', ['docs:read'], signal())]);
  await f.tools.cancel(f.a, 'fixture', a.transactionId);
  await expect(f.tools.complete(f.a, 'fixture', a.transactionId, signal())).rejects.toThrow('private transaction');
  await f.tools.complete(f.returnedB, 'fixture', b.transactionId, signal());
  expect((await f.tools.invoke(f.shared, 'fixture', { argv: ['docs', 'list'], cwd: f.root, identity: 'auto', signal: signal() })).stdout).toBe('bot');
  expect(vi.mocked(f.provider.invoke).mock.calls[0]?.[0].credentialRef).toBeUndefined();
  await expect(f.tools.invoke(f.shared, 'fixture', { argv: ['docs', 'list'], cwd: f.root, identity: 'user', signal: signal() })).rejects.toThrow('authorization');
});

it('an account mismatch, cancellation or missing scope fails before a provider request', async () => {
  const f = await setup();
  const other = fixture('other-account');
  const foreign = await authorize(other);
  await expect(f.tools.begin(foreign, 'fixture', ['docs:read'], signal())).rejects.toThrow('authorization');
  await expect(f.tools.begin(f.a, 'fixture', [], signal())).rejects.toThrow('scopes');
  const cancelled = new AbortController(); cancelled.abort();
  await expect(f.tools.begin(f.a, 'fixture', ['docs:read'], cancelled.signal)).rejects.toThrow();
  expect(f.provider.begin).not.toHaveBeenCalled();
});

it('migrates expired legacy bindings without restoring revoked grants or extending pending OAuth', async () => {
  const f = await setup();
  const a = await f.tools.begin(f.a, 'fixture', ['docs:read'], signal());
  const ag = await f.tools.complete(f.returnedA, 'fixture', a.transactionId, signal());
  const b = await f.tools.begin(f.b, 'fixture', ['docs:read'], signal());
  await f.tools.complete(f.returnedB, 'fixture', b.transactionId, signal());
  await f.tools.revoke(f.b, 'fixture');
  const pending = await f.tools.begin(f.b, 'fixture', ['docs:read'], signal());
  const legacy = JSON.parse(await readFile(f.file, 'utf8'));
  legacy.schema = 'aria.space.tool-identity.v1';
  legacy.grants[0].expiresAt = 6000;
  await writeFile(f.file, JSON.stringify(legacy), { mode: 0o600 });

  const later = 365 * 24 * 60 * 60_000;
  const identity = new SpaceToolIdentity(f.authorization, () => later, f.file);
  await identity.load();
  expect(identity.find(f.a, 'fixture')).toEqual(ag);
  expect(identity.find(f.b, 'fixture')).toBeUndefined();
  expect(() => identity.transaction(f.b, pending.transactionId)).toThrow('private transaction');
  const migrated = JSON.parse(await readFile(f.file, 'utf8'));
  expect(migrated.schema).toBe('aria.space.tool-identity.v2');
  expect(migrated.grants).toEqual([ag]);
  expect(migrated.grants[0]).not.toHaveProperty('expiresAt');
  expect(migrated.pending).toEqual(legacy.pending);
  const content = await readFile(f.file, 'utf8');
  await identity.load();
  expect(await readFile(f.file, 'utf8')).toBe(content);

  const tools = new SpaceToolCredentials(f.authorization, identity, () => later);
  tools.register(f.provider);
  const request = { argv: ['docs', 'list'], cwd: f.root, identity: 'user' as const, signal: signal() };
  expect((await tools.invoke(f.a, 'fixture', request)).stdout).toBe('user');
  expect(f.provider.invoke).toHaveBeenLastCalledWith(expect.objectContaining({ credentialRef: ag.credentialRef, identity: 'user' }));
  vi.mocked(f.provider.invoke).mockRejectedValueOnce(new Error('provider authorization revoked'));
  await expect(tools.invoke(f.a, 'fixture', request)).rejects.toThrow('provider authorization revoked');
  expect(f.provider.invoke).toHaveBeenCalledTimes(2);
  await tools.revoke(f.a, 'fixture');
  const restarted = new SpaceToolIdentity(f.authorization, () => later + 1000, f.file);
  await restarted.load();
  expect(restarted.find(f.a, 'fixture')).toBeUndefined();
});
