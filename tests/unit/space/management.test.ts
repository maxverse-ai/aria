import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createRootConfig, loadRootConfig, saveRootConfig } from '../../../src/config/profile-store';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { SpaceManagementService, type SpaceMigrationAdapter } from '../../../src/space/management';
import type { SpaceDeploymentDefinition } from '../../../src/space/deployment';
import { preparationPaths, readPreparation, preparationStoragePaths } from '../../../src/space/preparation-store';
import { createSelectedSpaceProfile } from '../../../src/space/selected-profile';
import { acquireProfileRuntimeLock } from '../../../src/runtime/locks';
import { ConfigChangeService } from '../../../src/application/control/config-change-service';
import { managementCommandRegistry } from '../../../src/application/control/management-commands';
import { runtimeProbeVersion } from '../../helpers/runtime';
import { PROFILE_MODE_TRANSITION_COMMAND } from '../../../src/application/control/profile-mode-command';
import { ManagementCommandRegistry } from '../../../src/application/control/management-command-registry';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const actor = { source: 'local-cli' as const, principal: 'fixture-admin' };
async function fixture(migration?: SpaceMigrationAdapter) {
  const rootDir = await mkdtemp(join(tmpdir(), 'aria-space-management-'));
  cleanups.push(() => rm(rootDir, { recursive: true, force: true }));
  const paths = resolveAppPaths({ rootDir, profile: 'bot' });
  const profile = createDefaultProfileConfig({ agentKind: 'codex', codex: { binaryPath: process.execPath },
    accounts: { app: { id: 'fixture-app', secret: 'fixture-only', tenant: 'feishu' } } });
  await saveRootConfig(createRootConfig('bot', profile), paths.configFile);
  const deployment: SpaceDeploymentDefinition = { schema: 'aria.space.deployment.v1', engineId: 'codex',
    binary: process.execPath, binaryVersion: runtimeProbeVersion, driver: 'trusted-process',
    workspaceAccess: profile.permissions.defaultAccess, executableRoots: [], environmentKeys: [], templates: [] };
  const service = new SpaceManagementService({ rootDir, migration,
    authorize: (candidate, name) => candidate.principal === actor.principal && candidate.source === actor.source && name === 'bot' });
  return { rootDir, paths, profile, deployment, service };
}
it('activation is explicit, durable and idempotent; rollback retains both legacy and newly written space state', async () => {
  const f = await fixture();
  await mkdir(f.paths.profileDir, { recursive: true });
  const legacy = JSON.stringify([{ key: 'legacy', scopeId: 'chat', agentId: 'codex', cwdRealpath: '/old',
    policyFingerprint: 'old-policy', status: 'active', updatedAt: 1, threadId: 'native-original' }]);
  await writeFile(f.paths.sessionsFile + '.catalog.json', legacy);
  const before = await readFile(f.paths.configFile, 'utf8');
  const selection = await f.service.prepare('bot', f.deployment, actor);
  expect(await readFile(f.paths.configFile, 'utf8')).toBe(before);
  expect(await f.service.prepare('bot', f.deployment, actor, selection.preparationId)).toEqual(selection);
  expect((await f.service.status('bot', actor)).execution).toBe('legacy');
  expect(await f.service.inspectPreparation('bot', selection, actor)).toMatchObject({ importedSessions: 0, sealedSessions: 1 });
  await expect(f.service.activate('bot', selection, actor)).rejects.toThrow('sealed legacy history');
  expect(await f.service.activate('bot', selection, actor, true)).toMatchObject({ changed: true, effect: 'restart' });
  expect(await f.service.activate('bot', selection, actor)).toMatchObject({ changed: false });
  const config = (await loadRootConfig(f.paths.configFile))!.profiles.bot!;
  expect(config.mode).toBe('team');
  expect(config.executionSpaces).toEqual(selection);
  const spaces = await createSelectedSpaceProfile({ profileId: 'bot', profileConfig: config, appPaths: f.paths });
  expect(spaces).toBeDefined(); await spaces!.services.close();
  const state = preparationPaths(f.paths.profileDir, selection.preparationId).state;
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'new-data'), 'written after activation');
  expect(await f.service.rollback('bot', actor)).toMatchObject({ changed: true });
  expect(await f.service.rollback('bot', actor)).toMatchObject({ changed: false });
  expect(await readFile(f.paths.configFile, 'utf8')).toBe(before);
  expect(await readFile(f.paths.sessionsFile + '.catalog.json', 'utf8')).toBe(legacy);
  expect(await readFile(join(state, 'new-data'), 'utf8')).toBe('written after activation');
});
it('lists staged, active and retained preparations without changing state', async () => {
  const f = await fixture();
  const before = await readFile(f.paths.configFile, 'utf8');
  const selection = await f.service.prepare('bot', f.deployment, actor);

  let list = await f.service.listPreparations('bot', actor);
  expect(list.schema).toBe('aria.space.list.v1');
  expect(list.profile).toBe('bot');
  expect(list.preparations).toHaveLength(1);
  expect(list.preparations[0]).toMatchObject({
    id: selection.preparationId, driver: 'trusted-process', engineId: 'codex',
    active: false, retained: false,
  });
  expect(await readFile(f.paths.configFile, 'utf8')).toBe(before);

  await f.service.activate('bot', selection, actor);
  list = await f.service.listPreparations('bot', actor);
  expect(list.preparations[0]).toMatchObject({ active: true, retained: false });

  await f.service.rollback('bot', actor);
  list = await f.service.listPreparations('bot', actor);
  expect(list.preparations[0]).toMatchObject({ active: false, retained: true });
});

it('activates and rolls back legacy Team with exec secret references without resolving or changing credentials', async () => {
  const f = await fixture();
  const root = (await loadRootConfig(f.paths.configFile))!;
  root.profiles.bot!.mode = 'team';
  root.secrets = { providers: { bridge: { source: 'exec', command: '/nonexistent/private-provider' } } };
  root.profiles.bot!.accounts.app.secret = { source: 'exec', provider: 'bridge', id: 'fixture-secret-handle' };
  root.profiles.bot!.secrets = { providers: { scoped: { source: 'exec', command: '/nonexistent/scoped-provider' } } };
  await saveRootConfig(root, f.paths.configFile);
  const original = await readFile(f.paths.configFile, 'utf8');
  const selection = await f.service.prepare('bot', f.deployment, actor);
  await f.service.activate('bot', selection, actor);
  expect(await f.service.status('bot', actor)).toMatchObject({ mode: 'team', executionMode: 'team', selection });
  const selected = (await loadRootConfig(f.paths.configFile))!;
  expect(selected.secrets).toEqual(root.secrets);
  expect(selected.profiles.bot!.accounts).toEqual(root.profiles.bot!.accounts);
  expect(selected.profiles.bot!.secrets).toEqual(root.profiles.bot!.secrets);
  await f.service.rollback('bot', actor);
  expect(await readFile(f.paths.configFile, 'utf8')).toBe(original);
  expect(await f.service.status('bot', actor)).toMatchObject({ mode: 'team', executionMode: 'legacy-team' });
});
it('running profiles, stale legacy data, destination changes and config changes cannot activate a preparation', async () => {
  const f = await fixture();
  const lock = await acquireProfileRuntimeLock(f.paths, 'codex');
  try { await expect(f.service.prepare('bot', f.deployment, actor)).rejects.toThrow('lock'); }
  finally { await lock.release(); }
  const selection = await f.service.prepare('bot', f.deployment, actor);
  await writeFile(f.paths.sessionsFile, '{}');
  await expect(f.service.activate('bot', selection, actor)).rejects.toThrow('legacy state changed');
  await rm(f.paths.sessionsFile);
  const staging = preparationPaths(f.paths.profileDir, selection.preparationId);
  await mkdir(staging.state, { recursive: true });
  await writeFile(join(staging.state, 'unverified'), 'changed');
  await expect(f.service.activate('bot', selection, actor)).rejects.toThrow('staged state changed');
  await rm(join(staging.state, 'unverified'));
  const root = (await loadRootConfig(f.paths.configFile))!;
  root.profiles.bot!.preferences.model = 'new-model';
  await saveRootConfig(root, f.paths.configFile);
  await expect(f.service.activate('bot', selection, actor)).rejects.toThrow('configuration changed');
  expect((await loadRootConfig(f.paths.configFile))!.profiles.bot!.mode).toBe('personal');
});
it('an interrupted preparation can retry exact inputs; a failed native proof never creates an activatable receipt', async () => {
  let fail = true;
  const f = await fixture({ prepare: async () => ({ importedKeys: [], verify: async () => { if (fail) throw new Error('native proof failed'); } }) });
  const id = 'a'.repeat(32);
  await expect(f.service.prepare('bot', f.deployment, actor, id)).rejects.toThrow('native proof failed');
  await expect(readFile(preparationPaths(f.paths.profileDir, id).receipt)).rejects.toMatchObject({ code: 'ENOENT' });
  fail = false;
  const selection = await f.service.prepare('bot', f.deployment, actor, id);
  expect(selection.preparationId).toBe(id);
  await expect(f.service.prepare('bot', { ...f.deployment, binaryVersion: 'invalid' }, actor, id)).rejects.toThrow('inputs changed');
});
it('ordinary management JSON and untrusted operators cannot obtain transition authority', async () => {
  const f = await fixture();
  await expect(f.service.status('bot', { source: 'agent', principal: actor.principal })).rejects.toThrow('trusted operator');
  const changes = new ConfigChangeService({ rootDir: f.rootDir, registry: managementCommandRegistry });
  await expect(changes.createPlan({ profile: 'bot', operationId: PROFILE_MODE_TRANSITION_COMMAND,
    actor, parameters: { mode: 'team' } })).rejects.toThrow('risk policy');
  const selection = await f.service.prepare('bot', f.deployment, actor);
  const path = preparationPaths(f.paths.profileDir, selection.preparationId).receipt;
  const receipt = JSON.parse(await readFile(path, 'utf8'));
  receipt.deployment.driver = 'execution';
  await writeFile(path, JSON.stringify(receipt), { mode: 0o600 });
  await expect(f.service.activate('bot', selection, actor)).rejects.toThrow('changed execution space preparation');
});

it('the mutation kernel keeps native configuration pinned while allowing admission preferences', async () => {
  const f = await fixture();
  const selection = await f.service.prepare('bot', f.deployment, actor);
  await f.service.activate('bot', selection, actor);
  const changes = new ConfigChangeService({ rootDir: f.rootDir, registry: new ManagementCommandRegistry([{
    id: 'fixture.native-home', version: 1, risk: 'low', effect: 'restart',
    prepare({ root, profile }) {
      root.profiles[profile]!.codex!.codexHome = '/foreign-home';
      return { root, changes: [{ field: 'codex.codexHome', before: null, after: '/foreign-home' }] };
    },
  }]) });
  await expect(changes.createPlan({ profile: 'bot', operationId: 'fixture.native-home', actor })).rejects.toThrow('preparation');
  const preferences = new ConfigChangeService({ rootDir: f.rootDir, registry: managementCommandRegistry });
  const plan = await preferences.createPlan({ profile: 'bot', operationId: 'config.require-mention.set',
    actor, parameters: { value: false } });
  await preferences.confirmPlan(plan.id, actor);
  await preferences.applyPlan(plan.id, actor);
  const config = (await loadRootConfig(f.paths.configFile))!.profiles.bot!;
  expect(config.executionSpaces).toEqual(selection);
  expect(config.access.requireMentionInGroup).toBe(false);
  const spaces = await createSelectedSpaceProfile({ profileId: 'bot', profileConfig: config, appPaths: f.paths });
  await spaces!.services.close();
});

it('upgrades an active preparation with a checked backup while preserving credential paths and later writes on rollback', async () => {
  const f = await fixture(); const original = await f.service.prepare('bot', f.deployment, actor);
  await f.service.activate('bot', original, actor);
  const state = preparationPaths(f.paths.profileDir, original.preparationId).state;
  await mkdir(state, { recursive: true, mode: 0o700 });
  const binding = JSON.stringify({ source: join(state, 'private-cli-config'), value: 'fixture-only' });
  await writeFile(join(state, 'binding-fixture.json'), binding, { mode: 0o600 });
  const next = await f.service.prepareUpgrade('bot', f.deployment, actor);
  expect(await f.service.prepareUpgrade('bot', f.deployment, actor, next.preparationId)).toEqual(next);
  const receipt = await readPreparation(f.paths.profileDir, next);
  expect(receipt.schema).toBe('aria.space.preparation.v2');
  expect(preparationStoragePaths(f.paths.profileDir, receipt).state).toBe(state);
  expect(await readFile(join(preparationPaths(f.paths.profileDir, next.preparationId).directory, 'backup', 'binding-fixture.json'), 'utf8')).toBe(binding);
  expect((await loadRootConfig(f.paths.configFile))!.profiles.bot!.executionSpaces).toEqual(original);
  await f.service.activate('bot', next, actor);
  const config = (await loadRootConfig(f.paths.configFile))!.profiles.bot!;
  const selected = await createSelectedSpaceProfile({ profileId: 'bot', profileConfig: config, appPaths: f.paths });
  expect(selected!.stateDirectory).toBe(state); await selected!.services.close();
  await writeFile(join(state, 'latest-output'), 'written after upgrade');
  await f.service.rollback('bot', actor);
  expect((await loadRootConfig(f.paths.configFile))!.profiles.bot!.executionSpaces).toEqual(original);
  expect(await readFile(join(state, 'binding-fixture.json'), 'utf8')).toBe(binding);
  expect(await readFile(join(state, 'latest-output'), 'utf8')).toBe('written after upgrade');
});

it('refuses an upgrade cutover when the current data changed after its backup', async () => {
  const f = await fixture(); const original = await f.service.prepare('bot', f.deployment, actor);
  await f.service.activate('bot', original, actor);
  const state = preparationPaths(f.paths.profileDir, original.preparationId).state;
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(join(state, 'latest'), 'first');
  const next = await f.service.prepareUpgrade('bot', f.deployment, actor);
  await writeFile(join(state, 'latest'), 'newer');
  await expect(f.service.activate('bot', next, actor)).rejects.toThrow('state changed');
  await expect(f.service.prepareUpgrade('bot', f.deployment, actor, next.preparationId)).rejects.toThrow('inputs changed');
  expect((await loadRootConfig(f.paths.configFile))!.profiles.bot!.executionSpaces).toEqual(original);
  expect(await readFile(join(state, 'latest'), 'utf8')).toBe('newer');
});


it('upgrades and rolls back native tool links without following or rewriting their targets', async () => {
  const f = await fixture(); const original = await f.service.prepare('bot', f.deployment, actor);
  await f.service.activate('bot', original, actor);
  const state = preparationPaths(f.paths.profileDir, original.preparationId).state;
  await mkdir(join(state, 'home/.codex/tmp/arg0'), { recursive: true });
  const link = 'home/.codex/tmp/arg0/apply_patch';
  await symlink('/outside-this-space/missing-codex', join(state, link));
  const next = await f.service.prepareUpgrade('bot', f.deployment, actor);
  const backup = join(preparationPaths(f.paths.profileDir, next.preparationId).directory, 'backup');
  expect(await readlink(join(backup, link))).toBe('/outside-this-space/missing-codex');
  await f.service.activate('bot', next, actor);
  await f.service.rollback('bot', actor);
  expect(await readlink(join(state, link))).toBe('/outside-this-space/missing-codex');
  expect((await loadRootConfig(f.paths.configFile))!.profiles.bot!.executionSpaces).toEqual(original);
});

it('rejects a link target changed after upgrade preparation', async () => {
  const f = await fixture(); const original = await f.service.prepare('bot', f.deployment, actor);
  await f.service.activate('bot', original, actor);
  const state = preparationPaths(f.paths.profileDir, original.preparationId).state;
  await mkdir(state, { recursive: true });
  await symlink('/first-target', join(state, 'link'));
  const next = await f.service.prepareUpgrade('bot', f.deployment, actor);
  await rm(join(state, 'link')); await symlink('/second-target', join(state, 'link'));
  await expect(f.service.activate('bot', next, actor)).rejects.toThrow('state changed');
});
