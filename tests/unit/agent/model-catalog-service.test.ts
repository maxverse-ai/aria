import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelCatalogService } from '../../../src/agent/model-catalog/service.js';
import { DEFAULT_MODEL } from '../../../src/agent/models.js';
import type { EnginePlugin } from '../../../src/agent/plugin/types.js';
import { registerEnginePlugin } from '../../../src/agent/plugin/registry.js';
import type { AgentAdapter } from '../../../src/agent/types.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';

const app = { id: 'cli_catalog_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };
let sequence = 0;

afterEach(() => vi.useRealTimers());

describe('ModelCatalogService', () => {
  it('prefers the live runtime and coalesces concurrent refreshes', async () => {
    const engineId = registerFakeEngine();
    const profileConfig = createDefaultProfileConfig({ agentKind: engineId, accounts: { app } });
    const service = new ModelCatalogService();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const query = {
      profileId: 'one',
      engineId,
      profileConfig,
      runtimeGeneration: 4,
      runtimeModels: async () => {
        calls++;
        await gate;
        return [{ value: 'runtime/model', label: 'Runtime Model' }];
      },
    };

    const first = service.refresh(query);
    const second = service.refresh(query);
    expect(first).toBe(second);
    release();
    const snapshot = await first;
    expect(calls).toBe(1);
    expect(snapshot.source).toBe('runtime');
    expect(snapshot.models.map((model) => model.value)).toEqual(['runtime/model', DEFAULT_MODEL]);
  });

  it('isolates catalogs belonging to different profiles', async () => {
    const engineId = registerFakeEngine();
    const profileConfig = createDefaultProfileConfig({ agentKind: engineId, accounts: { app } });
    const service = new ModelCatalogService();
    const one = await service.refresh({
      profileId: 'one', engineId, profileConfig,
      runtimeModels: async () => [{ value: 'one/model', label: 'One' }],
    });
    const two = await service.refresh({
      profileId: 'two', engineId, profileConfig,
      runtimeModels: async () => [{ value: 'two/model', label: 'Two' }],
    });
    expect(one.models[0]?.value).toBe('one/model');
    expect(two.models[0]?.value).toBe('two/model');
  });

  it('returns a static snapshot at the soft timeout and aborts at the hard timeout', async () => {
    vi.useFakeTimers();
    const engineId = registerFakeEngine();
    const profileConfig = createDefaultProfileConfig({ agentKind: engineId, accounts: { app } });
    const service = new ModelCatalogService();
    let aborted = false;
    const result = service.list({
      profileId: 'slow', engineId, profileConfig,
      runtimeModels: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
    });

    await vi.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toMatchObject({ source: 'static', stale: true });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(aborted).toBe(true);
  });
});

function registerFakeEngine(): string {
  const id = `catalog-fake-${++sequence}`;
  registerEnginePlugin({
    id,
    displayName: id,
    sessionKind: id,
    supportsNativeHistory: false,
    probes: [],
    capability: (profile) => ({
      agentId: id,
      sessionKind: id,
      promptInjection: 'stdin-prefix',
      systemPrompt: '',
      supportsNativeHistory: false,
      callback: { marker: '__bridge_cb', legacyMarkers: [] },
      permissions: { maxAccess: profile.permissions.maxAccess },
    }),
    createRuntime: () => ({
      engineId: id,
      execution: {
        id,
        displayName: id,
        isAvailable: async () => true,
        run: () => ({
          runId: '',
          events: { async *[Symbol.asyncIterator]() {} },
          stop: async () => undefined,
          waitForExit: async () => true,
        }),
      } satisfies AgentAdapter,
      dispose: async () => undefined,
    }),
    modelOptions: () => [{ value: DEFAULT_MODEL, label: 'Default' }],
  } satisfies EnginePlugin);
  return id;
}
