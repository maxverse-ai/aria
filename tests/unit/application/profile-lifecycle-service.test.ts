import { mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProfileLifecycleService,
  PROFILE_LIFECYCLE_ELEVATED_COMMANDS,
  authorizeAdapterCommands,
  type ActiveProfileProjector,
  type ControlActorContext,
  type ProfileRetentionStore,
} from '../../../src/application/control';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';

const roots: string[] = [];
const actor: ControlActorContext = { source: 'agent', principal: 'profile-lifecycle-test' };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ProfileLifecycleService', () => {
  it('bootstraps the first prepared profile without impersonating a management plan', async () => {
    const rootDir = await makeRoot();
    const service = lifecycleService(rootDir);

    const result = await service.create('primary', preparedProfile('cli_primary'), actor);

    expect(result).toMatchObject({
      profile: 'primary',
      path: 'bootstrap',
      projection: { status: 'applied', profile: 'primary' },
    });
    expect((await loadRootConfig(join(rootDir, 'config.json')))?.activeProfile).toBe('primary');
    await expect(readFile(join(rootDir, 'active-profile'), 'utf8')).resolves.toBe('primary\n');
    await expect(readdir(join(rootDir, 'control', 'plans'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('adds a prepared profile through profile.create while preserving active selection', async () => {
    const rootDir = await createFixture();
    const service = lifecycleService(rootDir);

    const result = await service.create('third', preparedProfile('cli_third'), actor);

    expect(result).toMatchObject({
      profile: 'third',
      path: 'management',
      projection: { status: 'applied', profile: 'primary' },
    });
    const root = await loadRootConfig(join(rootDir, 'config.json'));
    expect(root?.activeProfile).toBe('primary');
    expect(root?.profiles.third?.accounts.app.id).toBe('cli_third');
    expect(await appliedOperation(rootDir)).toBe('profile.create');
  });

  it('archives the active profile and commits the deterministic fallback', async () => {
    const rootDir = await createFixture();
    const service = lifecycleService(rootDir, {
      now: () => new Date('2026-08-29T12:34:56.000Z'),
    });

    const result = await service.archive('primary', actor);

    expect(result).toMatchObject({
      mode: 'archive',
      cleanup: { status: 'not-required' },
      projection: { status: 'applied', profile: 'secondary' },
    });
    expect((await loadRootConfig(join(rootDir, 'config.json')))?.activeProfile).toBe('secondary');
    await expect(stat(join(rootDir, '.trash', 'primary-20260829T123456Z'))).resolves.toBeDefined();
    expect(await appliedOperation(rootDir)).toBe('profile.archive');
  });

  it('restores staged state when archive authorization is unavailable', async () => {
    const rootDir = await createFixture();
    const service = new ProfileLifecycleService({ rootDir });

    await expect(service.archive('primary', actor)).rejects.toMatchObject({
      code: 'operation-unavailable',
    });

    expect((await loadRootConfig(join(rootDir, 'config.json')))?.profiles.primary).toBeDefined();
    await expect(stat(join(rootDir, 'profiles', 'primary'))).resolves.toBeDefined();
  });

  it('purges the last profile and atomically removes root config and its projection', async () => {
    const rootDir = await createSingleProfileFixture();
    const service = lifecycleService(rootDir);

    const result = await service.purge('primary', actor);

    expect(result).toMatchObject({
      mode: 'purge',
      cleanup: { status: 'applied' },
      projection: { status: 'applied' },
    });
    await expect(stat(join(rootDir, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(rootDir, 'active-profile'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(rootDir, 'profiles', 'primary'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await appliedOperation(rootDir)).toBe('profile.purge');
  });

  it('reports purge cleanup failure separately from committed desired state', async () => {
    const rootDir = await createSingleProfileFixture();
    const retentionStore: ProfileRetentionStore = {
      async stage(request) {
        return {
          profile: request.profile,
          mode: request.mode,
          async restore() {},
          async finalize() {
            throw new Error('cleanup failed');
          },
        };
      },
    };
    const service = lifecycleService(rootDir, { retentionStore });

    const result = await service.purge('primary', actor);

    expect(result.cleanup).toEqual({ status: 'failed', code: 'retention-cleanup-failed' });
    await expect(stat(join(rootDir, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports projection failure separately from the committed desired state', async () => {
    const rootDir = await createFixture();
    const projector: ActiveProfileProjector = {
      async project(request) {
        return {
          status: 'failed',
          profile: request.profile,
          revision: request.expectedRevision,
          code: 'projection-write-failed',
        };
      },
      async clear(request) {
        return { status: 'applied', revision: request.expectedRevision };
      },
    };
    const service = new ProfileLifecycleService({ rootDir, projector });

    const result = await service.activate('secondary', actor);

    expect(result).toMatchObject({
      profile: 'secondary',
      changed: true,
      projection: { status: 'failed', code: 'projection-write-failed' },
    });
    expect((await loadRootConfig(join(rootDir, 'config.json')))?.activeProfile).toBe('secondary');
    await expect(readFile(join(rootDir, 'active-profile'), 'utf8')).resolves.toBe('primary\n');
  });

  it('fails without changing desired state for an unknown profile', async () => {
    const rootDir = await createFixture();
    const service = new ProfileLifecycleService({ rootDir });

    await expect(service.activate('missing', actor)).rejects.toMatchObject({
      code: 'profile-not-found',
    });
    expect((await loadRootConfig(join(rootDir, 'config.json')))?.activeProfile).toBe('primary');
  });
});

async function createFixture(): Promise<string> {
  const rootDir = await makeRoot();
  const paths = resolveAppPaths({ rootDir, profile: 'primary' });
  const primary = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: { app: { id: 'cli_primary', secret: '${APP_SECRET}', tenant: 'feishu' } },
  });
  const root = createRootConfig('primary', primary);
  root.profiles.secondary = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_secondary', secret: '${APP_SECRET}', tenant: 'feishu' } },
    codex: { binaryPath: 'codex' },
  });
  await saveRootConfig(root, paths.configFile);
  await writeActiveProfile(rootDir, 'primary');
  await Promise.all([
    mkdir(join(rootDir, 'profiles', 'primary'), { recursive: true }),
    mkdir(join(rootDir, 'profiles', 'secondary'), { recursive: true }),
  ]);
  return rootDir;
}

async function createSingleProfileFixture(): Promise<string> {
  const rootDir = await makeRoot();
  const definition = preparedProfile('cli_primary');
  await saveRootConfig(
    createRootConfig('primary', definition.config, definition.rootSecrets),
    join(rootDir, 'config.json'),
  );
  await writeActiveProfile(rootDir, 'primary');
  await mkdir(join(rootDir, 'profiles', 'primary'), { recursive: true });
  return rootDir;
}

async function makeRoot(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'aria-profile-lifecycle-'));
  roots.push(rootDir);
  return rootDir;
}

function preparedProfile(appId: string) {
  const rootSecrets = {
    providers: {
      bridge: {
        source: 'exec' as const,
        command: '/opt/aria/secrets-getter',
        args: [],
      },
    },
  };
  return {
    config: createDefaultProfileConfig({
      agentKind: 'claude',
      accounts: {
        app: {
          id: appId,
          secret: { source: 'exec', provider: 'bridge', id: `app-${appId}` },
          tenant: 'feishu',
        },
      },
      secrets: rootSecrets,
    }),
    rootSecrets,
  };
}

function lifecycleService(
  rootDir: string,
  options: Omit<ConstructorParameters<typeof ProfileLifecycleService>[0], 'rootDir' | 'authorizeCommand'> = {},
): ProfileLifecycleService {
  return new ProfileLifecycleService({
    rootDir,
    ...options,
    authorizeCommand: authorizeAdapterCommands('agent', PROFILE_LIFECYCLE_ELEVATED_COMMANDS),
  });
}

async function appliedOperation(rootDir: string): Promise<string> {
  const planDir = join(rootDir, 'control', 'plans');
  const names = (await readdir(planDir)).filter((name) => name.endsWith('.json')).sort();
  const plan = JSON.parse(await readFile(join(planDir, names.at(-1)!), 'utf8')) as {
    operation: { id: string };
  };
  return plan.operation.id;
}
