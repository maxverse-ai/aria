import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerEnginePlugin } from '../../../src/agent/plugin/registry';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import {
  EngineSwitchRuntimeReconciler,
  prepareEngineSwitch,
  stageEngineBootstrap,
} from '../../../src/runtime/engine-switch';
import { FakeAgentAdapter } from '../../helpers/fake-agent';

const roots: string[] = [];
const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const targetPlugin = {
  id: 'engine-switch-target',
  displayName: 'Engine Switch Target',
  sessionKind: 'engine-switch-session',
  supportsNativeHistory: false,
  probes: [],
  configField: 'codex',
  bootstrapConfig: async () => ({ binaryPath: 'engine-switch-target' }),
  capability: (profile: ReturnType<typeof createDefaultProfileConfig>) => ({
    agentId: 'engine-switch-target',
    sessionKind: 'engine-switch-session',
    promptInjection: 'stdin-prefix' as const,
    systemPrompt: '',
    supportsNativeHistory: false,
    callback: { marker: '__bridge_cb' as const, legacyMarkers: [] },
    permissions: { maxAccess: profile.permissions.maxAccess },
  }),
  createRuntime: () => ({
    engineId: 'engine-switch-target',
    execution: new FakeAgentAdapter({ id: 'engine-switch-target' }),
    dispose: async () => undefined,
  }),
};

function registerTarget(): void {
  registerEnginePlugin(targetPlugin);
}

describe('engine switch preparation and runtime administration', () => {
  it('builds an isolated candidate and clears the previous engine model', async () => {
    registerTarget();
    const current = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
    current.preferences.model = 'claude-opus-4-8';

    const prepared = await prepareEngineSwitch(current, 'engine-switch-target');

    expect(current.agentKind).toBe('claude');
    expect(current.preferences.model).toBe('claude-opus-4-8');
    expect(prepared.profileConfig.agentKind).toBe('engine-switch-target');
    expect(prepared.profileConfig.preferences.model).toBeUndefined();
  });

  it('stages only inactive bootstrap config and rejects stale writers', async () => {
    registerTarget();
    const rootDir = await mkdtemp(join(tmpdir(), 'engine-switch-'));
    roots.push(rootDir);
    const configPath = join(rootDir, 'config.json');
    const current = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
    await saveRootConfig(createRootConfig('aria', current), configPath);
    const persisted = (await loadRootConfig(configPath))!.profiles.aria!;
    const prepared = await prepareEngineSwitch(persisted, 'engine-switch-target');

    const staged = await stageEngineBootstrap({
      configPath,
      profile: 'aria',
      expectedAgentKind: 'claude',
      expectedProfileConfig: persisted,
      preparedProfileConfig: prepared.profileConfig,
      targetAgentKind: 'engine-switch-target',
    });
    expect(staged.profileConfig.agentKind).toBe('claude');
    expect(staged.profileConfig.codex?.binaryPath).toBe('engine-switch-target');
    expect((await loadRootConfig(configPath))?.profiles.aria).toMatchObject({
      agentKind: 'claude',
      codex: { binaryPath: 'engine-switch-target' },
    });

    await expect(
      stageEngineBootstrap({
        configPath,
        profile: 'aria',
        expectedAgentKind: 'claude',
        expectedProfileConfig: persisted,
        preparedProfileConfig: prepared.profileConfig,
        targetAgentKind: 'engine-switch-target',
      }),
    ).rejects.toThrow(/configuration changed concurrently/);
  });

  it('accepts only the engine-switch runtime effect', async () => {
    const seen: string[] = [];
    const reconciler = new EngineSwitchRuntimeReconciler(async (request) => {
      seen.push(request.revision);
    });

    await expect(reconciler.reconcile({
      profile: 'aria',
      effect: 'engine-switch',
      revision: 'sha256:target',
    })).resolves.toEqual({ status: 'applied', effect: 'engine-switch' });
    await expect(reconciler.reconcile({
      profile: 'aria',
      effect: 'reconnect',
      revision: 'sha256:other',
    })).resolves.toEqual({
      status: 'failed',
      effect: 'reconnect',
      code: 'engine-switch-effect-required',
    });
    expect(seen).toEqual(['sha256:target']);
  });
});
