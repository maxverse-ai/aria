import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { SpaceManagementService } from '../../../src/space/management';
import { nativeSessionMigration } from '../../../src/space/session-migration';
import { openPreparedSpaceHost } from '../../../src/space/host';
import { digest } from '../../../src/space/deployment';
import { spaceMigrationEngineMain } from '../../helpers/space-migration-engine';
import type { SpaceAuthorization } from '../../../src/space/authorization';
import { createProfileConversationHost } from '../../../src/conversation/profile-host';
import type { SessionCatalogEntry } from '../../../src/session/catalog';
import { evaluateRunPolicy } from '../../../src/policy/run-policy';
import { spacePolicyProfile } from '../../../src/space/policy-profile';
import { codexCapability } from '../../../src/agent/capability';

const cleanups: Array<() => Promise<unknown>> = [];
// This fixture observes on the real clock. No case here asserts that a lease
// expires, so the lease only has to outlive the slowest host the suite runs on;
// a tight one turns a loaded machine into "space binding is stale or suspended".
const OBSERVATION_LEASE_MS = 60 * 60_000;
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const actor = { source: 'local-cli' as const, principal: 'fixture-admin' };
function authorize(authorization: SpaceAuthorization, scope: string, owner: string) {
  const source = authorization.registerSource({ profileId: 'p', providerId: 'fixture', accountId: 'bot', instanceId: 'source' });
  return authorization.authorize({ observation: source.observe({ conversationId: scope, actorId: owner, actorKind: 'user',
    selfId: 'bot', kind: scope.startsWith('solo') ? 'group' : 'direct', authenticated: true, complete: true,
    humans: [owner], agents: ['bot'], revision: 1, observedAt: Date.now(), expiresAt: Date.now() + OBSERVATION_LEASE_MS }),
    scopeRef: scope, admitted: true, mode: 'team', accessCeiling: 'workspace' });
}
it('verified histories migrate per user, solo and DM share storage, unknown history stays sealed and the next request resumes the old ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-space-import-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolveAppPaths({ rootDir: root, profile: 'p' });
  const binary = join(root, 'codex');
  await writeFile(binary, '#!' + process.execPath + '\n(' + spaceMigrationEngineMain.toString() + ')();\n', { mode: 0o755 });
  const profile = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: binary },
    permissions: { defaultAccess: 'workspace', maxAccess: 'workspace' },
    accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } } });
  await saveRootConfig(createRootConfig('p', profile), paths.configFile);
  await mkdir(paths.profileDir, { recursive: true });
  const entries: SessionCatalogEntry[] = [];
  const sources = new Map<string, { nativeId: string; sourceFile: string; sha256: string }>();
  for (const scopeId of ['dm-a', 'solo-a', 'dm-b', 'unknown']) {
    const id = randomUUID();
    const sourceFile = join(root, 'rollout-2026-09-07T00-00-00-' + id + '.jsonl');
    const contents = JSON.stringify({ type: 'session_meta', payload: { id, cwd: '/legacy' } }) + '\n';
    await writeFile(sourceFile, contents, { mode: 0o600 });
    sources.set(scopeId, { nativeId: id, sourceFile, sha256: digest(contents) });
    entries.push({ key: scopeId, scopeId, agentId: 'codex', cwdRealpath: '/legacy',
      policyFingerprint: 'legacy', status: 'active', threadId: id, updatedAt: 1 });
  }
  const before = JSON.stringify(entries);
  await writeFile(paths.sessionsFile + '.catalog.json', before);
  const service = new SpaceManagementService({ rootDir: root, authorize: candidate => candidate.principal === actor.principal,
    migration: nativeSessionMigration({ resolve: async ({ entry, authorization }) => {
      if (entry.scopeId === 'unknown') return undefined;
      const owner = entry.scopeId.endsWith('a') ? 'a' : 'b';
      return { context: await authorize(authorization, entry.scopeId, owner),
        scope: { source: 'channel:fixture', actorId: owner },
        nativeSource: sources.get(entry.scopeId)!, evidenceDigest: digest('fixture historical ownership:' + entry.scopeId) };
    } }) });
  const selection = await service.prepare('p', { schema: 'aria.space.deployment.v1', engineId: 'codex', binary,
    binaryVersion: '1.0.0', driver: 'trusted-process', executableRoots: [], environmentKeys: [], templates: [], workspaceAccess: 'workspace' }, actor);
  const source = sources.get('dm-a')!;
  const originalSource = await readFile(source.sourceFile);
  await writeFile(source.sourceFile, Buffer.concat([originalSource, Buffer.from('new native event\n')]));
  await expect(service.activate('p', selection, actor, true)).rejects.toThrow('native source changed');
  await writeFile(source.sourceFile, originalSource);
  await service.activate('p', selection, actor, true);
  expect(await service.status('p', actor)).toMatchObject({ importedSessions: 3, sealedSessions: 1 });
  const owner = await openPreparedSpaceHost({ rootDir: root, profileId: 'p' });
  cleanups.push(() => owner.close());
  await expect(openPreparedSpaceHost({ rootDir: root, profileId: 'p' })).rejects.toThrow('lock');
  const auth = owner.spaces.services.authorization;
  const a = await authorize(auth, 'dm-a', 'a'), solo = await authorize(auth, 'solo-a', 'a'), b = await authorize(auth, 'dm-b', 'b');
  const sa = await owner.spaces.services.state.view(a), sb = await owner.spaces.services.state.view(b);
  expect(auth.inspect(a).binding.spaceId).toBe(auth.inspect(solo).binding.spaceId);
  expect(auth.inspect(a).executionScope).not.toBe(auth.inspect(solo).executionScope);
  expect(sa.sessionCatalog.entries().map(entry => entry.threadId).sort()).toEqual([sources.get('dm-a')!.nativeId, sources.get('solo-a')!.nativeId].sort());
  expect(sb.sessionCatalog.entries().map(entry => entry.threadId)).toEqual([sources.get('dm-b')!.nativeId]);
  const current = (await loadRootConfig(paths.configFile))!.profiles.p!;
  const effective = spacePolicyProfile(current, sa.paths, 'workspace');
  const policy = evaluateRunPolicy({ scope: { source: 'channel:fixture', actorId: 'a' }, attachments: [], prompt: 'continue',
    requestedCwd: sa.paths.workspace, cwdRealpath: sa.paths.workspace, profileConfig: effective,
    capability: codexCapability(effective), access: { ok: true, reason: 'allowed-team' }, now: Date.now(),
    codexHome: effective.codex?.codexHome, inheritCodexHome: effective.codex?.inheritCodexHome });
  expect(policy.ok).toBe(true);
  if (!policy.ok) throw new Error('policy denied');
  expect(sa.sessionCatalog.activeFor({ scopeId: auth.inspect(a).executionScope, agentId: 'codex',
    cwdRealpath: sa.paths.workspace, policyFingerprint: policy.policyFingerprint })?.threadId).toBe(sources.get('dm-a')!.nativeId);
  const host = await createProfileConversationHost({ configPath: paths.configFile, profile: 'p',
    stateDirectory: join(root, 'fixture-external'), spaceProfile: owner.spaces });
  try {
    const events: import('../../../src/agent/types').AgentEvent[] = [];
    const result = await host.run({ spaceContext: a, scopeId: 'dm-a', actorId: 'a', prompt: 'continue',
      source: 'channel:fixture', authorized: true, attachments: [], onEvent: event => { events.push(event); } });
    expect(result).toMatchObject({ ok: true, content: 'continued fixture' });
    expect(events).toContainEqual(expect.objectContaining({ type: 'system', threadId: sources.get('dm-a')!.nativeId }));
  } finally { await host.close(); }
  expect(await readFile(paths.sessionsFile + '.catalog.json', 'utf8')).toBe(before);
}, 20_000);
