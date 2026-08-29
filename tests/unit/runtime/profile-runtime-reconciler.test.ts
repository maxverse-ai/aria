import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configRevision } from '../../../src/application/control';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  createRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  ProfileRuntimeReconciler,
  type ProfileRuntimeReconcileTarget,
} from '../../../src/runtime/profile-runtime-reconciler';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ProfileRuntimeReconciler', () => {
  it('reloads a committed live revision into the running profile projection', async () => {
    const fixture = await createFixture();
    const next = structuredClone(fixture.rootConfig);
    next.profiles.primary!.preferences.showToolCalls = false;
    await saveRootConfig(next, fixture.target.configPath);

    const result = await new ProfileRuntimeReconciler(fixture.target).reconcile({
      profile: 'primary',
      effect: 'live',
      revision: configRevision(next),
    });

    expect(result).toEqual({ status: 'applied', effect: 'live' });
    expect(fixture.target.cfg.preferences?.showToolCalls).toBe(false);
    expect(fixture.target.profileConfig.preferences.showToolCalls).toBe(false);
    expect(fixture.target.restart).not.toHaveBeenCalled();
  });

  it('reconnects only after confirming the desired revision on disk', async () => {
    const fixture = await createFixture();

    await expect(
      new ProfileRuntimeReconciler(fixture.target).reconcile({
        profile: 'primary',
        effect: 'reconnect',
        revision: 'sha256:stale',
      }),
    ).resolves.toEqual({
      status: 'failed',
      effect: 'reconnect',
      code: 'desired-revision-mismatch',
    });
    expect(fixture.target.restart).not.toHaveBeenCalled();

    const result = await new ProfileRuntimeReconciler(fixture.target).reconcile({
      profile: 'primary',
      effect: 'reconnect',
      revision: configRevision(fixture.rootConfig),
    });
    expect(result).toEqual({ status: 'applied', effect: 'reconnect' });
    expect(fixture.target.restart).toHaveBeenCalledWith({ wait: true });
  });

  it('defers process restarts and rejects a different runtime profile', async () => {
    const fixture = await createFixture();
    const reconciler = new ProfileRuntimeReconciler(fixture.target);

    await expect(reconciler.reconcile({
      profile: 'primary',
      effect: 'restart',
      revision: configRevision(fixture.rootConfig),
    })).resolves.toEqual({
      status: 'deferred',
      effect: 'restart',
      reason: 'process-restart-required',
    });
    await expect(reconciler.reconcile({
      profile: 'secondary',
      effect: 'live',
      revision: configRevision(fixture.rootConfig),
    })).resolves.toEqual({
      status: 'failed',
      effect: 'live',
      code: 'runtime-profile-mismatch',
    });
  });
});

async function createFixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'aria-runtime-reconcile-'));
  roots.push(rootDir);
  const appPaths = resolveAppPaths({ rootDir, profile: 'primary' });
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: 'secret-test', tenant: 'feishu' } },
    codex: { binaryPath: 'codex' },
  });
  const rootConfig = createRootConfig('primary', profile);
  await saveRootConfig(rootConfig, appPaths.configFile);
  const target: ProfileRuntimeReconcileTarget = {
    profile: 'primary',
    configPath: appPaths.configFile,
    cfg: runtimeProfileConfig(rootConfig, 'primary'),
    profileConfig: rootConfig.profiles.primary!,
    restart: vi.fn(async () => undefined),
  };
  return { rootConfig, target };
}
