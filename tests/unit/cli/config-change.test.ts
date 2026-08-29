import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ControlActorContext } from '../../../src/application/control';
import {
  runConfigApply,
  runConfigConfirm,
  runConfigPlan,
  runConfigPlanShow,
  runConfigSettings,
} from '../../../src/cli/commands/config-change';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

const roots: string[] = [];
const actor: ControlActorContext = { source: 'local-cli', principal: 'test-user' };

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('config change CLI handlers', () => {
  it('drives settings discovery and plan -> show -> confirm -> apply using JSON contracts', async () => {
    const fixture = await createFixture();
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((value) => output.push(String(value)));

    await runConfigSettings({ json: true });
    const settings = JSON.parse(output.pop()!);
    expect(settings.schema).toBe('aria.control.config-settings.v1');
    expect(settings.settings).toHaveLength(8);
    expect(settings.settings).not.toContainEqual(expect.objectContaining({
      setting: 'steering',
    }));

    await runConfigPlan('show-tool-calls', 'false', {
      rootDir: fixture.root,
      actor,
      json: true,
    });
    const plan = JSON.parse(output.pop()!);
    expect(plan).toMatchObject({
      schema: 'aria.control.change-plan.v1',
      status: 'planned',
      operation: { id: 'config.show-tool-calls.set', restartRequired: true },
    });

    await runConfigPlanShow(plan.id, { rootDir: fixture.root, actor, json: true });
    expect(JSON.parse(output.pop()!).status).toBe('planned');
    await runConfigConfirm(plan.id, { rootDir: fixture.root, actor, json: true });
    expect(JSON.parse(output.pop()!).status).toBe('confirmed');
    await runConfigApply(plan.id, { rootDir: fixture.root, actor, json: true });
    expect(JSON.parse(output.pop()!)).toMatchObject({
      schema: 'aria.control.change-apply.v1',
      restartRequired: true,
    });

    const root = await loadRootConfig(fixture.configPath);
    expect(root?.profiles.primary?.preferences.showToolCalls).toBe(false);
  });
});

async function createFixture(): Promise<{ root: string; configPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'aria-config-cli-'));
  roots.push(root);
  const appPaths = resolveAppPaths({ rootDir: root, profile: 'primary' });
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: 'secret-test', tenant: 'feishu' } },
    codex: { binaryPath: 'codex' },
  });
  await saveRootConfig(createRootConfig('primary', profile), appPaths.configFile);
  await writeActiveProfile(root, 'primary');
  return { root, configPath: appPaths.configFile };
}
