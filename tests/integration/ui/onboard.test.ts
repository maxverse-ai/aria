import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeNewProfile } from '../../../src/ui/onboard';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret } from '../../../src/config/keystore';
import { loadRootConfig } from '../../../src/config/profile-store';
import { secretKeyForApp } from '../../../src/config/schema';
import { acquireProfileRuntimeLock } from '../../../src/runtime/locks';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function tmpRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bridge-onboard-'));
  roots.push(root);
  return root;
}

describe('writeNewProfile (new-profile is additive)', () => {
  it('refuses to overwrite an existing profile and lets a new name coexist', async () => {
    const root = await tmpRoot();
    const base = {
      profile: 'claude',
      agentKind: 'claude' as const,
      appSecret: 'secret',
      tenant: 'feishu' as const,
      workspace: root,
    };

    const first = await writeNewProfile({ ...base, appId: 'cli_a' }, root);
    expect(first.profile).toBe('claude');

    // Same name → refuse (do NOT clobber the existing profile).
    await expect(writeNewProfile({ ...base, appId: 'cli_b' }, root)).rejects.toThrow(/已存在/);

    // The existing profile still points at the original app.
    const afterCollision = (await loadRootConfig(join(root, 'config.json')))!;
    expect(afterCollision.profiles.claude?.accounts.app.id).toBe('cli_a');

    // A different name is added alongside.
    const second = await writeNewProfile({ ...base, profile: 'work', appId: 'cli_b' }, root);
    expect(second.profile).toBe('work');
    const root2 = (await loadRootConfig(join(root, 'config.json')))!;
    expect(Object.keys(root2.profiles).sort()).toEqual(['claude', 'work']);
    expect(root2.activeProfile).toBe('claude');
    await expect(readFile(join(root, 'active-profile'), 'utf8')).resolves.toBe('claude\n');
    const plans = (await readdir(join(root, 'control', 'plans')))
      .filter((name) => name.endsWith('.json'));
    expect(plans).toHaveLength(1);
    const plan = JSON.parse(await readFile(join(root, 'control', 'plans', plans[0]!), 'utf8'));
    expect(plan.operation.id).toBe('profile.create');
  });

  it('creates a profile with a Unicode (Chinese) name from the scanned bot name', async () => {
    const root = await tmpRoot();

    const created = await writeNewProfile(
      {
        profile: '助手',
        agentKind: 'claude',
        appId: 'cli_nimo',
        appSecret: 'secret',
        tenant: 'feishu',
        workspace: root,
      },
      root,
    );
    expect(created.profile).toBe('助手');

    const cfg = (await loadRootConfig(join(root, 'config.json')))!;
    expect(cfg.profiles['助手']?.accounts.app.id).toBe('cli_nimo');
  });

  it('rejects a path-unsafe profile name with a clear 400 (not a 500)', async () => {
    const root = await tmpRoot();
    await expect(
      writeNewProfile(
        { profile: 'a/b', agentKind: 'claude', appId: 'cli_x', appSecret: 's', tenant: 'feishu' },
        root,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects concurrent provisioning before credentials or desired state are written', async () => {
    const root = await tmpRoot();
    const appPaths = resolveAppPaths({ rootDir: root, profile: 'locked' });
    const lock = await acquireProfileRuntimeLock(appPaths, 'claude');
    try {
      await expect(
        writeNewProfile(
          {
            profile: 'locked',
            agentKind: 'claude',
            appId: 'cli_locked',
            appSecret: 'secret',
            tenant: 'feishu',
          },
          root,
        ),
      ).rejects.toMatchObject({ status: 409 });

      await expect(loadRootConfig(appPaths.configFile)).resolves.toBeUndefined();
      await expect(getSecret(secretKeyForApp('cli_locked'), appPaths)).resolves.toBeUndefined();
    } finally {
      await lock.release();
    }
  });
});
