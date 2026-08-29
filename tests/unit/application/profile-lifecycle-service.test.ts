import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProfileLifecycleService,
  type ActiveProfileProjector,
  type ControlActorContext,
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
  const rootDir = await mkdtemp(join(tmpdir(), 'aria-profile-lifecycle-'));
  roots.push(rootDir);
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
  return rootDir;
}
