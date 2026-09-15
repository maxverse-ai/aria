import { describe, expect, it, vi } from 'vitest';
import {
  startProfileExternalChannelRuntime,
  type ExternalChannelPluginComposition,
} from '../../../src/runtime/external-channel-runtime';
import type { ExternalChannelPluginPackageSource } from '../../../src/channel/plugin/loader';
import type {
  ChannelPlugin,
  ChannelRuntime,
  ResolvedChannelInstance,
} from '../../../src/channel/plugin/types';
import {
  channelPluginPackage,
  NOOP_EXTERNAL_CHANNEL_PACKAGE,
  NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
  NOOP_EXTERNAL_CHANNEL_VERSION,
} from '../../fixtures/channel/noop-external-channel-plugin';

const request = Object.freeze({
  package: NOOP_EXTERNAL_CHANNEL_PACKAGE,
  version: NOOP_EXTERNAL_CHANNEL_VERSION,
});
const trust = Object.freeze({ ...request, pluginId: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID });

function instance(
  instanceId = 'primary',
  overrides: Partial<ResolvedChannelInstance> = {},
): ResolvedChannelInstance {
  return {
    profileId: 'fixture-profile',
    pluginId: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
    instanceId,
    enabled: true,
    configVersion: 1,
    config: { label: instanceId },
    secretRefs: {},
    ...overrides,
  };
}

function source(plugin: ChannelPlugin = channelPluginPackage.channelPlugin) {
  const value: ExternalChannelPluginPackageSource & {
    resolve: ReturnType<typeof vi.fn>;
    importModule: ReturnType<typeof vi.fn>;
  } = {
    resolve: vi.fn(async () => ({
      specifier: 'fixture:noop-channel',
      metadata: { name: request.package, version: request.version },
    })),
    importModule: vi.fn(async () => ({ channelPluginPackage: { channelPlugin: plugin } })),
  };
  return value;
}

function composition(packageSource = source()): ExternalChannelPluginComposition {
  return {
    trustedPackages: [trust],
    source: packageSource,
    createIngress: () => ({
      accept: async () => ({ status: 'accepted', receiptId: 'fixture-receipt' }),
    }),
  };
}

describe('profile external channel runtime', () => {
  it('prepared profiles never use an external plugin legacy ingress or another profile authority', async () => {
    const spaces = { services: {} } as import('../../../src/space/profile').PreparedSpaceProfile;
    const legacy = vi.fn(composition().createIngress);
    const base = { profileId: 'fixture-profile', requests: [request], instances: [instance()], spaces };
    await expect(startProfileExternalChannelRuntime({ ...base,
      composition: { ...composition(), createIngress: legacy } })).rejects.toThrow('prepared space ingress authority');
    expect(legacy).not.toHaveBeenCalled();
    await expect(startProfileExternalChannelRuntime({ ...base, composition: { ...composition(),
      createSpaceIngress: () => ({ ...composition().createIngress({ profileId: 'fixture-profile' }),
        spaceAuthority: {} as import('../../../src/space/services').ExecutionSpaceServices }) } })).rejects.toThrow('prepared space ingress authority');
    const runtime = await startProfileExternalChannelRuntime({ ...base, composition: { ...composition(), createIngress: legacy,
      createSpaceIngress: input => ({ ...composition().createIngress({ profileId: input.profileId }), spaceAuthority: input.spaces.services }) } });
    expect(runtime.snapshot().manager.readyCount).toBe(1);
    expect(legacy).not.toHaveBeenCalled();
    await runtime.close();
  });
  it('loads exact trusted packages, starts only enabled instances, and unloads after close', async () => {
    const packageSource = source();
    const runtime = await startProfileExternalChannelRuntime({
      profileId: 'fixture-profile',
      requests: [request],
      instances: [instance(), instance('disabled', { enabled: false })],
      composition: composition(packageSource),
    });

    expect(runtime.snapshot()).toMatchObject({
      profileId: 'fixture-profile',
      loadedPlugins: [trust],
      manager: { state: 'ready', instanceCount: 1, readyCount: 1 },
    });
    await runtime.close();
    await runtime.close();
    expect(runtime.snapshot()).toMatchObject({
      loadedPlugins: [],
      manager: { state: 'stopped', instanceCount: 1, readyCount: 0 },
    });
    expect(packageSource.resolve).toHaveBeenCalledTimes(1);
    expect(packageSource.importModule).toHaveBeenCalledTimes(1);
  });

  it('rolls back an earlier instance and unloads the package when a later start fails', async () => {
    const closed: string[] = [];
    const plugin: ChannelPlugin = {
      ...channelPluginPackage.channelPlugin,
      async start(context): Promise<ChannelRuntime> {
        if (context.instance.instanceId === 'broken') throw new Error('fixture start failed');
        return {
          instance: context.instance,
          snapshot: () => ({
            ...context.instance,
            state: 'ready',
            acceptingInbound: true,
            inFlightInbound: 0,
            inFlightOutbound: 0,
            updatedAt: 1,
          }),
          health: async () => ({ status: 'healthy', checkedAt: 1 }),
          deliver: async (intent) => ({
            deliveryId: intent.deliveryId,
            status: 'sent',
            deliveredAt: 1,
          }),
          drain: async () => ({ drained: true, remainingInbound: 0, remainingOutbound: 0 }),
          close: async () => { closed.push(context.instance.instanceId); },
        };
      },
    };
    const packageSource = source(plugin);

    await expect(startProfileExternalChannelRuntime({
      profileId: 'fixture-profile',
      requests: [request],
      instances: [instance('first'), instance('broken')],
      composition: composition(packageSource),
    })).rejects.toThrow('fixture start failed');

    expect(closed).toEqual(['first']);
    expect(packageSource.importModule).toHaveBeenCalledTimes(1);
  });

  it('fails before package resolution when deployment trust does not match desired state', async () => {
    const packageSource = source();
    await expect(startProfileExternalChannelRuntime({
      profileId: 'fixture-profile',
      requests: [request],
      instances: [instance()],
      composition: {
        ...composition(packageSource),
        trustedPackages: [],
      },
    })).rejects.toMatchObject({ code: 'untrusted-channel-plugin-package' });
    expect(packageSource.resolve).not.toHaveBeenCalled();
    expect(packageSource.importModule).not.toHaveBeenCalled();
  });
});
