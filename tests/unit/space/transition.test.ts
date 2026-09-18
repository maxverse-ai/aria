import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { acquireProfileRuntimeLock, type AcquiredRuntimeLock } from '../../../src/runtime/locks';
import { SpaceManagementService } from '../../../src/space/management';
import { SpaceTransitionCoordinator, pendingSpaceTransition, type SpaceTransitionRuntime } from '../../../src/space/transition';
import type { SpaceDeploymentDefinition } from '../../../src/space/deployment';
import { readPreparation, preparationStoragePaths } from '../../../src/space/preparation-store';
import { nodeHelperBinary, runtimeProbeVersion } from '../../helpers/runtime';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const actor = { source: 'local-cli' as const, principal: 'fixture-operator' };
async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'aria-transition-'));
  cleanups.push(() => rm(rootDir, { recursive: true, force: true }));
  const paths = resolveAppPaths({ rootDir, profile: 'bot' });
  await mkdir(paths.profileDir, { recursive: true });
  const profile = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: process.execPath }, accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } } });
  await saveRootConfig(createRootConfig('bot', profile), paths.configFile);
  let lock: AcquiredRuntimeLock | undefined = await acquireProfileRuntimeLock(paths, 'codex');
  cleanups.push(async () => { await lock?.release(); lock = undefined; });
  const trace: string[] = []; let fenced = false;
  const runtime: SpaceTransitionRuntime = {
    running: async () => Boolean(lock),
    drain: vi.fn(async () => { trace.push('drain'); fenced = true; }),
    stop: vi.fn(async () => { trace.push('stop'); if (lock) { await lock.release(); lock = undefined; } }),
    start: vi.fn(async () => { trace.push('start'); if (!lock) lock = await acquireProfileRuntimeLock(paths, 'codex'); fenced = await pendingSpaceTransition(paths.profileDir); }),
    healthy: vi.fn(async () => { trace.push('health'); if (!lock || !fenced) throw new Error('startup must remain fenced'); }),
    resume: vi.fn(async () => { trace.push('resume'); fenced = false; }),
  };
  const management = new SpaceManagementService({ rootDir, authorize: candidate => candidate.principal === actor.principal && candidate.source === actor.source });
  const coordinator = new SpaceTransitionCoordinator({ rootDir, management, runtime });
  const deployment: SpaceDeploymentDefinition = { schema: 'aria.space.deployment.v1', engineId: 'codex', binary: process.execPath,
    binaryVersion: runtimeProbeVersion, driver: 'trusted-process', workspaceAccess: profile.permissions.defaultAccess,
    executableRoots: [], environmentKeys: [], templates: [] };
  return { rootDir, paths, runtime, trace, management, coordinator, deployment };
}

it('upgrades an active preparation while retaining data paths and rolls back without discarding new writes', async () => {
  const f = await fixture();
  await f.coordinator.enable('bot', f.deployment, actor);
  const original = (await f.management.status('bot', actor)).selection!;
  expect((await f.coordinator.preflight('bot', f.deployment, actor, 'upgrade')).readyToAttempt).toBe(true);
  expect((await f.coordinator.preflight('bot', f.deployment, actor)).readyToAttempt).toBe(false);
  const receipt = await readPreparation(f.paths.profileDir, original);
  const state = preparationStoragePaths(f.paths.profileDir, receipt).state;
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'history-proof'), 'existing history');
  expect(await f.coordinator.upgrade('bot', f.deployment, actor)).toMatchObject({ operation: 'upgrade', phase: 'healthy' });
  const selected = (await f.management.status('bot', actor)).selection!;
  expect(selected).not.toEqual(original);
  expect(preparationStoragePaths(f.paths.profileDir, await readPreparation(f.paths.profileDir, selected)).state).toBe(state);
  await writeFile(join(state, 'after-upgrade'), 'new history');
  await f.coordinator.rollback('bot', actor);
  expect((await f.management.status('bot', actor)).selection).toEqual(original);
  expect(await readFile(join(state, 'after-upgrade'), 'utf8')).toBe('new history');
});

it('failed upgrade preparation restores the existing Team rather than rolling it back to personal mode', async () => {
  const f = await fixture();
  await f.coordinator.enable('bot', f.deployment, actor);
  const original = (await f.management.status('bot', actor)).selection;
  vi.spyOn(f.management, 'prepareUpgrade').mockRejectedValueOnce(new Error('backup not verified'));
  await expect(f.coordinator.upgrade('bot', f.deployment, actor)).rejects.toThrow('backup not verified');
  const status = await f.management.status('bot', actor);
  expect(status.selection).toEqual(original);
  expect(status.mode).toBe('team'); expect(status.running).toBe(true);
  expect(await pendingSpaceTransition(f.paths.profileDir)).toBe(false);
});

it('failed upgraded readiness returns to the previous preparation and preserves data', async () => {
  const f = await fixture();
  await f.coordinator.enable('bot', f.deployment, actor);
  const original = (await f.management.status('bot', actor)).selection;
  vi.mocked(f.runtime.healthy).mockRejectedValueOnce(new Error('candidate unavailable'));
  await expect(f.coordinator.upgrade('bot', f.deployment, actor)).rejects.toThrow('candidate unavailable');
  expect((await f.management.status('bot', actor)).selection).toEqual(original);
  expect(await pendingSpaceTransition(f.paths.profileDir)).toBe(false);
});

it('one managed transition drains, prepares, starts fenced, verifies health and resumes; rollback retains its prepared state', async () => {
  const f = await fixture();
  expect((await f.coordinator.preflight('bot', f.deployment, actor)).readyToAttempt).toBe(true);
  expect(f.trace).toEqual([]);
  const result = await f.coordinator.enable('bot', f.deployment, actor);
  expect(result.phase).toBe('healthy');
  expect(f.trace).toEqual(['drain', 'stop', 'start', 'health', 'resume']);
  expect(await pendingSpaceTransition(f.paths.profileDir)).toBe(false);
  const status = await f.management.status('bot', actor);
  expect(status.execution).toBe('prepared-spaces'); expect(status.running).toBe(true);
  const receiptFile = join(f.paths.profileDir, 'space-control', 'preparations', status.selection!.preparationId, 'receipt.json');
  const receipt = await readFile(receiptFile, 'utf8');
  expect(await f.coordinator.rollback('bot', actor)).toMatchObject({ phase: 'rolled-back' });
  expect((await f.management.status('bot', actor)).mode).toBe('personal');
  expect(await readFile(receiptFile, 'utf8')).toBe(receipt);
});

it('failed drain resumes existing work without stopping or preparing the live profile', async () => {
  const f = await fixture();
  vi.mocked(f.runtime.drain).mockRejectedValueOnce(new Error('active conversation'));
  await expect(f.coordinator.enable('bot', f.deployment, actor)).rejects.toThrow('active conversation');
  expect(f.runtime.stop).not.toHaveBeenCalled(); expect(f.runtime.start).not.toHaveBeenCalled();
  expect(f.runtime.resume).toHaveBeenCalledTimes(1);
  expect((await f.management.status('bot', actor)).mode).toBe('personal');
  expect((await f.management.status('bot', actor)).running).toBe(true);
  expect(await pendingSpaceTransition(f.paths.profileDir)).toBe(false);
});

it('failed readiness restores original configuration and process, while a failed restoration is recoverable after restart', async () => {
  const f = await fixture();
  const original = await readFile(f.paths.configFile, 'utf8');
  vi.mocked(f.runtime.healthy).mockRejectedValueOnce(new Error('native read unavailable')).mockRejectedValueOnce(new Error('prior process unavailable'));
  await expect(f.coordinator.enable('bot', f.deployment, actor)).rejects.toThrow('recovery requires');
  expect(await pendingSpaceTransition(f.paths.profileDir)).toBe(true);
  expect(await readFile(f.paths.configFile, 'utf8')).toBe(original);
  await expect(f.coordinator.enable('bot', f.deployment, actor)).rejects.toThrow('requires recovery');
  const restored = new SpaceTransitionCoordinator({ rootDir: f.rootDir, management: f.management, runtime: f.runtime });
  expect(await restored.recover('bot', actor)).toMatchObject({ phase: 'rolled-back' });
  expect((await f.management.status('bot', actor)).running).toBe(true);
  expect(await pendingSpaceTransition(f.paths.profileDir)).toBe(false);
});

it('unattributed history is preserved and requires the declared acceptance option before activation', async () => {
  const f = await fixture();
  const catalog = JSON.stringify([{ key: 'legacy', scopeId: 'old-chat', agentId: 'codex', cwdRealpath: '/legacy',
    policyFingerprint: 'old', status: 'active', updatedAt: 1, threadId: 'old-thread' }]);
  await writeFile(f.paths.sessionsFile + '.catalog.json', catalog);
  await expect(f.coordinator.enable('bot', f.deployment, actor)).rejects.toThrow('sealed history');
  expect((await f.management.status('bot', actor)).mode).toBe('personal');
  const enabled = await f.coordinator.enable('bot', f.deployment, actor, { acceptSealedHistory: true });
  expect(enabled.sealedSessions).toBe(1);
  expect(await readFile(f.paths.sessionsFile + '.catalog.json', 'utf8')).toBe(catalog);
});

it('unauthenticated callers cannot control a process and concurrent transition owners cannot overlap', async () => {
  const f = await fixture();
  await expect(f.coordinator.enable('bot', f.deployment, { source: 'agent', principal: actor.principal })).rejects.toThrow('trusted operator');
  expect(f.trace).toEqual([]);
  let release!: () => void;
  vi.mocked(f.runtime.drain).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const first = f.coordinator.enable('bot', f.deployment, actor);
  await vi.waitFor(() => expect(f.runtime.drain).toHaveBeenCalledTimes(1));
  try { await expect(f.coordinator.enable('bot', f.deployment, actor)).rejects.toThrow(/lock/i); }
  finally { release(); }
  expect((await first).phase).toBe('healthy');
});


it('reactivates retained Team data after rollback and explicitly reviews legacy changes', async () => {
  const f = await fixture();
  await f.coordinator.enable('bot', f.deployment, actor);
  const selection = (await f.management.status('bot', actor)).selection!;
  const state = join(f.paths.profileDir, 'space-control', 'preparations', selection.preparationId, 'state');
  await mkdir(join(state, 'workspace'), { recursive: true });
  await writeFile(join(state, 'workspace', 'new-user-file'), 'created in Team');
  await symlink('new-user-file', join(state, 'workspace', 'ordinary-project-symlink'));
  await mkdir(join(state, 'space-control'), { recursive: true });
  await writeFile(join(state, 'space-control', 'read-access.v1.json'), JSON.stringify({ schema: 'aria.space.read-access.v1', records: [{ digest: 'old-private-ticket' }] }));
  await f.coordinator.rollback('bot', actor);
  expect(JSON.parse(await readFile(join(state, 'space-control', 'read-access.v1.json'), 'utf8')).records).toEqual([]);
  expect((await f.management.status('bot', actor)).retained).toMatchObject([{ selection, legacyChanged: false }]);
  await expect(f.coordinator.enable('bot', f.deployment, actor)).rejects.toThrow('retained Team history');
  await writeFile(f.paths.sessionsFile + '.catalog.json', JSON.stringify([{ key: 'new-legacy', scopeId: 'legacy-chat', agentId: 'codex', cwdRealpath: '/legacy', policyFingerprint: 'legacy', status: 'active', updatedAt: 2, threadId: 'legacy-thread' }]));
  expect((await f.management.status('bot', actor)).retained[0]!.legacyChanged).toBe(true);
  await expect(f.coordinator.reactivate('bot', selection, actor)).rejects.toThrow('legacy changes');
  await f.coordinator.reactivate('bot', selection, actor, { acceptLegacyDelta: true });
  expect((await f.management.status('bot', actor)).selection).toEqual(selection);
  expect(await readFile(join(state, 'workspace', 'new-user-file'), 'utf8')).toBe('created in Team');
  expect(await readFile(f.paths.sessionsFile + '.catalog.json', 'utf8')).toContain('legacy-thread');
  expect((await f.coordinator.status('bot', actor)).transition).toMatchObject({ operation: 'reactivate', phase: 'healthy' });
});


it('rejects an unavailable rollback target before draining or changing the current selection', async () => {
  const f = await fixture();
  const oldBinary = join(f.rootDir, 'old-native-binary');
  await symlink(process.execPath, oldBinary);
  await f.coordinator.enable('bot', { ...f.deployment, binary: oldBinary }, actor);
  await f.coordinator.upgrade('bot', f.deployment, actor);
  const before = await readFile(f.paths.configFile, 'utf8');
  const trace = [...f.trace];
  await rm(oldBinary);
  await expect(f.coordinator.rollback('bot', actor)).rejects.toThrow('startup probe');
  expect(await readFile(f.paths.configFile, 'utf8')).toBe(before);
  expect(f.trace).toEqual(trace);
  expect((await f.management.status('bot', actor)).running).toBe(true);
  expect(await pendingSpaceTransition(f.paths.profileDir)).toBe(false);
});

it('rejects a native user-identity downgrade before stopping the current service', async () => {
  const f = await fixture();
  await f.coordinator.enable('bot', f.deployment, actor);
  await f.coordinator.upgrade('bot', { ...f.deployment, queryNode: nodeHelperBinary,
    tools: { larkCli: { binary: process.execPath, binaryVersion: runtimeProbeVersion, userAuthorization: true } } }, actor);
  const before = await readFile(f.paths.configFile, 'utf8');
  const trace = [...f.trace];
  await expect(f.coordinator.rollback('bot', actor)).rejects.toThrow('personal identity isolation');
  expect(await readFile(f.paths.configFile, 'utf8')).toBe(before);
  expect(f.trace).toEqual(trace);
  await f.runtime.stop('bot');
  await expect(f.management.rollback('bot', actor)).rejects.toThrow('personal identity isolation');
  expect(await readFile(f.paths.configFile, 'utf8')).toBe(before);
});

it('recovers a committed rollback after failed health without rolling back a second generation', async () => {
  const f = await fixture();
  await f.coordinator.enable('bot', f.deployment, actor);
  const original = (await f.management.status('bot', actor)).selection;
  await f.coordinator.upgrade('bot', f.deployment, actor);
  vi.mocked(f.runtime.healthy).mockRejectedValueOnce(new Error('restart temporarily unavailable'));
  await expect(f.coordinator.rollback('bot', actor)).rejects.toThrow('rollback interrupted');
  expect((await f.management.status('bot', actor)).selection).toEqual(original);
  const rollback = vi.spyOn(f.management, 'rollback');
  const restarted = new SpaceTransitionCoordinator({ rootDir: f.rootDir, management: f.management, runtime: f.runtime });
  expect(await restarted.recover('bot', actor)).toMatchObject({ phase: 'rolled-back' });
  expect(rollback).not.toHaveBeenCalled();
  expect((await f.management.status('bot', actor)).selection).toEqual(original);
  expect(await pendingSpaceTransition(f.paths.profileDir)).toBe(false);
  const trace = [...f.trace];
  expect(await restarted.recover('bot', actor)).toEqual({ changed: false });
  expect(f.trace).toEqual(trace);
});

it('recovers a failed upgrade restoration using the immutable receipt even with a legacy journal', async () => {
  const f = await fixture();
  await f.coordinator.enable('bot', f.deployment, actor);
  const original = (await f.management.status('bot', actor)).selection;
  vi.mocked(f.runtime.healthy).mockRejectedValueOnce(new Error('candidate down')).mockRejectedValueOnce(new Error('prior restart down'));
  await expect(f.coordinator.upgrade('bot', f.deployment, actor)).rejects.toThrow('recovery requires');
  const path = join(f.paths.profileDir, 'space-control', 'transition.v1.json');
  const journal = JSON.parse(await readFile(path, 'utf8'));
  delete journal.originalMode;
  await writeFile(path, JSON.stringify(journal), { mode: 0o600 });
  const rollback = vi.spyOn(f.management, 'rollback');
  expect(await f.coordinator.recover('bot', actor)).toMatchObject({ phase: 'rolled-back' });
  expect(rollback).not.toHaveBeenCalled();
  expect((await f.management.status('bot', actor)).selection).toEqual(original);
});

it('recovers a committed legacy rollback and preserves the original Team mode', async () => {
  const f = await fixture();
  await f.runtime.stop('bot');
  const root = (await loadRootConfig(f.paths.configFile))!;
  root.profiles.bot!.mode = 'team';
  await saveRootConfig(root, f.paths.configFile);
  await f.runtime.start('bot');
  await f.coordinator.enable('bot', f.deployment, actor);
  vi.mocked(f.runtime.healthy).mockRejectedValueOnce(new Error('restart unavailable'));
  await expect(f.coordinator.rollback('bot', actor)).rejects.toThrow('rollback interrupted');
  expect(await f.coordinator.recover('bot', actor)).toMatchObject({ phase: 'rolled-back' });
  const status = await f.management.status('bot', actor);
  expect(status.mode).toBe('team'); expect(status.selection).toBeUndefined(); expect(status.running).toBe(true);
});

it('refuses foreign selection removal during rollback recovery without touching its runtime', async () => {
  const f = await fixture();
  await f.coordinator.enable('bot', f.deployment, actor);
  await f.coordinator.upgrade('bot', f.deployment, actor);
  vi.mocked(f.runtime.healthy).mockRejectedValueOnce(new Error('restart unavailable'));
  await expect(f.coordinator.rollback('bot', actor)).rejects.toThrow('rollback interrupted');
  const root = (await loadRootConfig(f.paths.configFile))!;
  delete root.profiles.bot!.executionSpaces;
  await saveRootConfig(root, f.paths.configFile);
  const trace = [...f.trace];
  await expect(f.coordinator.recover('bot', actor)).rejects.toThrow('changed ownership');
  expect(f.trace).toEqual(trace);
  expect(await pendingSpaceTransition(f.paths.profileDir)).toBe(true);
});
