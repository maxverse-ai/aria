import { describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { DEFAULT_MODEL } from '../../../src/agent/models.js';
import type { EnginePlugin } from '../../../src/agent/plugin/types.js';
import { listEngineModels } from '../../../src/agent/model-catalog/index.js';
import { registerEnginePlugin } from '../../../src/agent/plugin/registry.js';
import type { AgentAdapter } from '../../../src/agent/types.js';

const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

describe('engine model cache', () => {
  it('merges dynamic and static model lists, falling back on lister failure', async () => {
    const profile = createDefaultProfileConfig({ agentKind: 'fake-models', accounts: { app } });
    registerEnginePlugin({
      id: 'fake-models',
      displayName: 'Fake Models',
      sessionKind: 'fake-session',
      supportsNativeHistory: false,
      probes: [],
      capability: (p) => ({
        agentId: 'fake-models',
        sessionKind: 'fake-session',
        promptInjection: 'stdin-prefix',
        systemPrompt: '',
        supportsNativeHistory: false,
        callback: { marker: '__bridge_cb', legacyMarkers: [] },
        permissions: { maxAccess: p.permissions.maxAccess },
      }),
      createRuntime: () => ({
        engineId: 'fake-models',
        execution: {
          id: 'fake-models',
          displayName: 'Fake Models',
          isAvailable: async () => true,
          run: () => ({
            runId: '',
            events: {
              async *[Symbol.asyncIterator]() {},
            },
            stop: async () => undefined,
            waitForExit: async () => true,
          }),
        } satisfies AgentAdapter,
        dispose: async () => undefined,
      }),
      modelOptions: () => [
        { value: DEFAULT_MODEL, label: 'default' },
        { value: 'static/model', label: 'Static' },
      ],
      modelLister: async () => [
        { value: 'dynamic/one', label: 'Dynamic One' },
        { value: 'dynamic/two', label: 'Dynamic Two' },
      ],
    } satisfies EnginePlugin);

    const options = await listEngineModels('fake-models', profile);
    expect(options.map((o) => o.value)).toEqual([
      'dynamic/one',
      'dynamic/two',
      'default',
      'static/model',
    ]);

    // Cache hit returns the same merged list without calling the lister again.
    expect(await listEngineModels('fake-models', profile)).toBe(options);
  });
});
