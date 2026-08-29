import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileConfigRepository } from '../../../src/application/control';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileConfigRepository', () => {
  it('owns locked atomic commits while returning an application result', async () => {
    const rootDir = await createFixture();
    const repository = new FileConfigRepository(rootDir);

    const result = await repository.withLockedRoot(async (root) => {
      root!.profiles.primary!.preferences.showToolCalls = false;
      return { nextRoot: root, result: { revision: 'next' } };
    });

    expect(result).toEqual({ revision: 'next' });
    expect((await repository.readRoot())?.profiles.primary?.preferences.showToolCalls).toBe(false);
  });

  it('does not persist a read-only transaction', async () => {
    const rootDir = await createFixture();
    const repository = new FileConfigRepository(rootDir);

    await repository.withLockedRoot(async (root) => {
      root!.profiles.primary!.preferences.showToolCalls = false;
      return { result: undefined };
    });

    const paths = resolveAppPaths({ rootDir, profile: 'primary' });
    expect((await loadRootConfig(paths.configFile))?.profiles.primary?.preferences.showToolCalls).toBe(true);
  });
});

async function createFixture(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'aria-config-repository-'));
  roots.push(rootDir);
  const paths = resolveAppPaths({ rootDir, profile: 'primary' });
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: 'secret-test', tenant: 'feishu' } },
    codex: { binaryPath: 'codex' },
  });
  profile.preferences.showToolCalls = true;
  await saveRootConfig(createRootConfig('primary', profile), paths.configFile);
  await writeActiveProfile(rootDir, 'primary');
  return rootDir;
}
