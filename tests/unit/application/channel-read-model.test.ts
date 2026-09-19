import { describe, expect, it } from 'vitest';
import {
  CHANNEL_READ_API_VERSION,
  diagnoseChannels,
  getChannelStatus,
  listChannelInstances,
  type ChannelQueryInput,
} from '../../../src/application/control/channel-read-model';
import type { ChannelManagerSnapshot } from '../../../src/channel/manager';
import type { ResolvedChannelInstance } from '../../../src/channel/plugin/types';
import type { ProfileExternalChannelRuntimeSnapshot } from '../../../src/runtime/external-channel-runtime';

function instance(overrides: Partial<ResolvedChannelInstance> = {}): ResolvedChannelInstance {
  return Object.freeze({
    profileId: 'work',
    pluginId: 'lark',
    instanceId: 'lark-primary',
    enabled: true,
    configVersion: 1,
    config: Object.freeze({ appId: 'cli_secret_name', credentialMode: 'secret-ref' }),
    secretRefs: Object.freeze({
      appSecret: Object.freeze({ source: 'exec' as const, id: 'app-secret-value-id' }),
    }),
    ...overrides,
  });
}

function managerSnapshot(
  instances: ChannelManagerSnapshot['instances'],
): ChannelManagerSnapshot {
  return {
    schema: 'aria.channel-manager.snapshot.v1',
    version: 1,
    profileId: 'work',
    state: 'ready',
    instanceCount: instances.length,
    readyCount: instances.filter((entry) => entry.state === 'ready').length,
    acceptingInbound: true,
    updatedAt: 1000,
    instances,
  };
}

const base: ChannelQueryInput = { profileId: 'work', instances: [], now: () => 42 };

describe('channel read model instance projection', () => {
  it('projects a managed built-in runtime entry with counters and codes only', () => {
    const rows = listChannelInstances({
      ...base,
      instances: [instance()],
      runtime: {
        lark: managerSnapshot([
          {
            profileId: 'work',
            pluginId: 'lark',
            instanceId: 'lark-primary',
            order: 0,
            state: 'ready',
            acceptingInbound: true,
            inFlightInbound: 2,
            inFlightOutbound: 1,
            updatedAt: 900,
          },
        ]),
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      pluginId: 'lark',
      instanceId: 'lark-primary',
      origin: 'built-in',
      desired: { enabled: true, configVersion: 1, secretRefCount: 1 },
      state: 'ready',
      acceptingInbound: true,
      inFlightInbound: 2,
      inFlightOutbound: 1,
      updatedAt: 900,
    });
  });

  it('maps pending manager entries to starting and runtime states through', () => {
    const states = ['pending', 'starting', 'ready', 'draining', 'stopped', 'failed', 'reauth-required'] as const;
    for (const state of states) {
      const [row] = listChannelInstances({
        ...base,
        instances: [instance()],
        runtime: {
          lark: managerSnapshot([
            {
              profileId: 'work',
              pluginId: 'lark',
              instanceId: 'lark-primary',
              order: 0,
              state,
              acceptingInbound: false,
              inFlightInbound: 0,
              inFlightOutbound: 0,
              updatedAt: 1,
            },
          ]),
        },
      });
      expect(row!.state).toBe(state === 'pending' ? 'starting' : state);
    }
  });

  it('reports enabled instances without a runtime as stopped and disabled as inactive', () => {
    const [stopped, inactive] = listChannelInstances({
      ...base,
      instances: [
        instance({ pluginId: 'weixin-ilink', instanceId: 'personal-1' }),
        instance({ pluginId: 'weixin-ilink', instanceId: 'personal-2', enabled: false }),
      ],
    });
    expect(stopped!.state).toBe('stopped');
    expect(stopped!.origin).toBe('external');
    expect(inactive!.state).toBe('inactive');
  });

  it('propagates stable failure codes without exception text', () => {
    const [row] = listChannelInstances({
      ...base,
      instances: [instance()],
      runtime: {
        lark: managerSnapshot([
          {
            profileId: 'work',
            pluginId: 'lark',
            instanceId: 'lark-primary',
            order: 0,
            state: 'failed',
            acceptingInbound: false,
            inFlightInbound: 0,
            inFlightOutbound: 0,
            updatedAt: 5,
            errorCode: 'channel-runtime-not-ready',
          },
        ]),
      },
    });
    expect(row!.state).toBe('failed');
    expect(row!.errorCode).toBe('channel-runtime-not-ready');
  });

  it('attaches pre-fetched health without triggering provider calls', () => {
    const [row] = listChannelInstances({
      ...base,
      instances: [instance()],
      health: [
        {
          profileId: 'work',
          pluginId: 'lark',
          instanceId: 'lark-primary',
          health: { status: 'degraded', checkedAt: 7, code: 'upstream-slow' },
        },
      ],
    });
    expect(row!.health).toEqual({ status: 'degraded', code: 'upstream-slow' });
  });
});

describe('channel status snapshot', () => {
  it('joins declared package pins with loader state on the package name', () => {
    const external: ProfileExternalChannelRuntimeSnapshot = {
      profileId: 'work',
      loadedPlugins: [{ package: '@acme/aria-channel-weixin-ilink', version: '0.1.0', pluginId: 'weixin-ilink' }],
      manager: managerSnapshot([]),
    };
    const status = getChannelStatus({
      ...base,
      declaredPackages: [
        { package: '@acme/aria-channel-weixin-ilink', version: '0.1.0' },
        { package: '@acme/aria-channel-unused', version: '1.0.0' },
      ],
      runtime: { external },
    });

    expect(status.schema).toBe('aria.channel.status.v1');
    expect(status.apiVersion).toBe(CHANNEL_READ_API_VERSION);
    expect(status.generatedAt).toBe(42);
    const byPackage = new Map(status.plugins.map((plugin) => [plugin.package, plugin]));
    expect(byPackage.get('@acme/aria-channel-weixin-ilink')).toMatchObject({
      declared: true,
      loaded: true,
      pluginId: 'weixin-ilink',
    });
    expect(byPackage.get('@acme/aria-channel-unused')).toMatchObject({
      declared: true,
      loaded: false,
    });
  });

  it('never projects config payloads, secret refs, or provider identities', () => {
    const status = getChannelStatus({
      ...base,
      instances: [instance()],
      declaredPackages: [{ package: '@acme/pkg', version: '1.0.0' }],
    });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain('cli_secret_name');
    expect(serialized).not.toContain('app-secret-value-id');
    expect(serialized).not.toContain('secret-ref');
  });
});

describe('channel diagnostics', () => {
  it('flags an enabled external instance whose plugin is not loaded', () => {
    const diagnostics = diagnoseChannels({
      ...base,
      instances: [instance({ pluginId: 'weixin-ilink', instanceId: 'personal-1' })],
      declaredPackages: [{ package: '@acme/aria-channel-weixin-ilink', version: '0.1.0' }],
    });
    expect(diagnostics).toContainEqual({
      severity: 'error',
      code: 'channel-plugin-not-loaded',
      pluginId: 'weixin-ilink',
      instanceId: 'personal-1',
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warn', code: 'channel-package-declared-not-loaded' }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'info', code: 'channel-instance-not-running' }),
    );
  });

  it('clears the load error once the plugin is loaded and running', () => {
    const diagnostics = diagnoseChannels({
      ...base,
      instances: [instance({ pluginId: 'weixin-ilink', instanceId: 'personal-1' })],
      declaredPackages: [{ package: '@acme/aria-channel-weixin-ilink', version: '0.1.0' }],
      runtime: {
        external: {
          profileId: 'work',
          loadedPlugins: [
            { package: '@acme/aria-channel-weixin-ilink', version: '0.1.0', pluginId: 'weixin-ilink' },
          ],
          manager: managerSnapshot([
            {
              profileId: 'work',
              pluginId: 'weixin-ilink',
              instanceId: 'personal-1',
              order: 0,
              state: 'ready',
              acceptingInbound: true,
              inFlightInbound: 0,
              inFlightOutbound: 0,
              updatedAt: 10,
            },
          ]),
        },
      },
    });
    expect(diagnostics.filter((entry) => entry.severity === 'error')).toHaveLength(0);
  });

  it('surfaces failed and reauth-required states as actionable diagnostics', () => {
    const runtime = managerSnapshot([
      {
        profileId: 'work',
        pluginId: 'lark',
        instanceId: 'lark-primary',
        order: 0,
        state: 'failed',
        acceptingInbound: false,
        inFlightInbound: 0,
        inFlightOutbound: 0,
        updatedAt: 1,
        errorCode: 'channel-lifecycle-failed',
      },
      {
        profileId: 'work',
        pluginId: 'weixin-ilink',
        instanceId: 'personal-1',
        order: 1,
        state: 'reauth-required',
        acceptingInbound: false,
        inFlightInbound: 0,
        inFlightOutbound: 0,
        updatedAt: 1,
      },
    ]);
    const diagnostics = diagnoseChannels({
      ...base,
      instances: [
        instance(),
        instance({ pluginId: 'weixin-ilink', instanceId: 'personal-1' }),
      ],
      runtime: { lark: runtime },
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'error', code: 'channel-instance-failed' }),
    );
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ severity: 'warn', code: 'channel-reauth-required' }),
    );
  });

  it('does not mutate its inputs and emits sorted serializable output', () => {
    const instances = [
      instance({ pluginId: 'weixin-ilink', instanceId: 'b' }),
      instance({ pluginId: 'weixin-ilink', instanceId: 'a' }),
      instance(),
    ];
    const input: ChannelQueryInput = { ...base, instances };
    const rows = listChannelInstances(input);
    expect(rows.map((row) => `${row.pluginId}/${row.instanceId}`)).toEqual([
      'lark/lark-primary',
      'weixin-ilink/a',
      'weixin-ilink/b',
    ]);
    expect(() => JSON.stringify(rows)).not.toThrow();
    expect(instances[0]!.instanceId).toBe('b');
  });
});
