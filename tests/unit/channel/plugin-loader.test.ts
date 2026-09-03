import { describe, expect, it, vi } from 'vitest';
import {
  ExternalChannelPluginLoader,
  InstalledChannelPluginPackageSource,
  type ExternalChannelPluginPackageSource,
  type TrustedExternalChannelPlugin,
} from '../../../src/channel/plugin/loader';
import { ChannelPluginRegistry } from '../../../src/channel/plugin/registry';
import type {
  ChannelPlugin,
  ChannelPluginPackage,
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

const trust = Object.freeze({
  ...request,
  pluginId: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
});

function fixtureInstance(
  overrides: Partial<ResolvedChannelInstance> = {},
): ResolvedChannelInstance {
  return {
    profileId: 'fixture-profile',
    pluginId: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
    instanceId: 'primary',
    enabled: true,
    configVersion: 1,
    config: { label: 'Fixture' },
    secretRefs: {},
    ...overrides,
  };
}

function fixtureModule(plugin: ChannelPlugin = channelPluginPackage.channelPlugin): {
  channelPluginPackage: ChannelPluginPackage;
} {
  return { channelPluginPackage: { channelPlugin: plugin } };
}

function fixtureSource(options: {
  metadata?: unknown;
  module?: unknown;
  importError?: Error;
} = {}): ExternalChannelPluginPackageSource & {
  resolve: ReturnType<typeof vi.fn>;
  importModule: ReturnType<typeof vi.fn>;
} {
  return {
    resolve: vi.fn(async (packageName: string) => ({
      specifier: `fixture:${packageName}`,
      metadata: options.metadata ?? {
        name: NOOP_EXTERNAL_CHANNEL_PACKAGE,
        version: NOOP_EXTERNAL_CHANNEL_VERSION,
      },
    })),
    importModule: vi.fn(async () => {
      if (options.importError) throw options.importError;
      return options.module ?? fixtureModule();
    }),
  };
}

function loader(options: {
  registry?: ChannelPluginRegistry;
  trustedPackages?: readonly TrustedExternalChannelPlugin[];
  source?: ExternalChannelPluginPackageSource;
} = {}): ExternalChannelPluginLoader {
  return new ExternalChannelPluginLoader({
    registry: options.registry ?? new ChannelPluginRegistry(),
    trustedPackages: options.trustedPackages ?? [trust],
    source: options.source ?? fixtureSource(),
  });
}

function pluginWith(
  manifest: Partial<ChannelPlugin['manifest']> = {},
  methods: Partial<Pick<ChannelPlugin, 'validateConfig' | 'start'>> = {},
): ChannelPlugin {
  const base = channelPluginPackage.channelPlugin;
  return {
    ...base,
    ...methods,
    manifest: {
      ...base.manifest,
      ...manifest,
      package: manifest.package ?? base.manifest.package,
    },
  };
}

function runtimeContext(instance = fixtureInstance()) {
  return {
    instance,
    signal: new AbortController().signal,
    ingress: {
      accept: async () => ({ status: 'accepted' as const, receiptId: 'fixture-1' }),
    },
  };
}

describe('ExternalChannelPluginLoader', () => {
  it('loads the no-network fixture, rejects active unload, then unloads and reloads', async () => {
    const registry = new ChannelPluginRegistry();
    const source = fixtureSource();
    const external = loader({ registry, source });

    await expect(external.load([request], [fixtureInstance()])).resolves.toEqual([
      { ...request, pluginId: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID },
    ]);
    expect(source.resolve.mock.invocationCallOrder[0]).toBeLessThan(
      source.importModule.mock.invocationCallOrder[0]!,
    );
    expect(registry.require(NOOP_EXTERNAL_CHANNEL_PLUGIN_ID)).toBe(
      channelPluginPackage.channelPlugin,
    );
    expect(external.list()).toEqual([{ ...request, pluginId: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID }]);

    const runtime = await registry.start(
      NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
      runtimeContext(),
    );
    expect(() => external.unload(NOOP_EXTERNAL_CHANNEL_PACKAGE)).toThrowError(
      expect.objectContaining({ code: 'active-channel-plugin-unload-denied' }),
    );
    expect(registry.get(NOOP_EXTERNAL_CHANNEL_PLUGIN_ID)).toBeDefined();

    await runtime.close();
    expect(external.unload(NOOP_EXTERNAL_CHANNEL_PACKAGE)).toBe(true);
    expect(external.list()).toEqual([]);
    await external.load([request], [fixtureInstance()]);
    expect(external.unloadAll()).toEqual([
      { ...request, pluginId: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID },
    ]);
  });

  it('denies untrusted, non-exact and duplicate desired packages before resolution', async () => {
    const source = fixtureSource();
    await expect(loader({ trustedPackages: [], source }).load([request])).rejects.toMatchObject({
      code: 'untrusted-channel-plugin-package',
    });
    await expect(
      loader({ source }).load([{ ...request, version: '^1.2.3' }]),
    ).rejects.toMatchObject({ code: 'invalid-channel-contract' });
    await expect(loader({ source }).load([request, request])).rejects.toMatchObject({
      code: 'duplicate-channel-plugin-package',
    });
    expect(source.resolve).not.toHaveBeenCalled();
    expect(source.importModule).not.toHaveBeenCalled();
  });

  it('validates installed metadata before importing executable code', async () => {
    const wrongVersion = fixtureSource({
      metadata: { name: NOOP_EXTERNAL_CHANNEL_PACKAGE, version: '1.2.4' },
    });
    await expect(loader({ source: wrongVersion }).load([request])).rejects.toMatchObject({
      code: 'channel-plugin-package-version-mismatch',
    });
    expect(wrongVersion.importModule).not.toHaveBeenCalled();

    const malformed = fixtureSource({ metadata: { name: request.package } });
    await expect(loader({ source: malformed }).load([request])).rejects.toMatchObject({
      code: 'invalid-channel-plugin-package-metadata',
    });
    expect(malformed.importModule).not.toHaveBeenCalled();
  });

  it('rejects import, export, ABI, package identity and trusted id mismatches', async () => {
    await expect(
      loader({ source: fixtureSource({ importError: new Error('fixture import failed') }) }).load([
        request,
      ]),
    ).rejects.toMatchObject({ code: 'channel-plugin-package-import-failed' });
    await expect(
      loader({ source: fixtureSource({ module: {} }) }).load([request]),
    ).rejects.toMatchObject({ code: 'invalid-channel-plugin-package-export' });
    await expect(
      loader({
        source: fixtureSource({
          module: fixtureModule(pluginWith({ abiVersion: 2 as never })),
        }),
      }).load([request]),
    ).rejects.toMatchObject({ code: 'invalid-channel-plugin-package-export' });
    await expect(
      loader({
        source: fixtureSource({
          module: fixtureModule(
            pluginWith({
              package: { name: request.package, version: '1.2.4' },
            }),
          ),
        }),
      }).load([request]),
    ).rejects.toMatchObject({ code: 'channel-plugin-manifest-package-mismatch' });
    await expect(
      loader({
        source: fixtureSource({
          module: fixtureModule(pluginWith({ id: 'different-fixture' })),
        }),
      }).load([request]),
    ).rejects.toMatchObject({ code: 'channel-plugin-id-mismatch' });
  });

  it('validates matching instance config and config version before registration', async () => {
    const registry = new ChannelPluginRegistry();
    const external = loader({ registry });
    await expect(
      external.load([request], [fixtureInstance({ config: {} })]),
    ).rejects.toMatchObject({ code: 'invalid-channel-plugin-config' });
    expect(registry.get(NOOP_EXTERNAL_CHANNEL_PLUGIN_ID)).toBeUndefined();

    await expect(
      external.load([request], [fixtureInstance({ configVersion: 2 })]),
    ).rejects.toMatchObject({ code: 'invalid-channel-plugin-config' });
    expect(registry.get(NOOP_EXTERNAL_CHANNEL_PLUGIN_ID)).toBeUndefined();
  });

  it('rejects duplicate trust ownership and built-in id collisions before import', async () => {
    expect(
      () =>
        loader({
          trustedPackages: [trust, { ...trust, package: '@fixture/another' }],
        }),
    ).toThrowError(expect.objectContaining({ code: 'duplicate-channel-plugin-trust' }));

    const registry = new ChannelPluginRegistry();
    registry.register(channelPluginPackage.channelPlugin);
    const source = fixtureSource();
    await expect(loader({ registry, source }).load([request])).rejects.toMatchObject({
      code: 'duplicate-channel-plugin-id',
    });
    expect(source.resolve).not.toHaveBeenCalled();
  });

  it('rolls back earlier registrations when a later batch registration fails', async () => {
    const secondPackage = '@fixture/aria-channel-second';
    const secondVersion = '2.0.0';
    const secondId = 'second-fixture';
    const secondPlugin = pluginWith({
      id: secondId,
      package: { name: secondPackage, version: secondVersion },
    });
    const source: ExternalChannelPluginPackageSource = {
      resolve: vi.fn(async (packageName: string) => ({
        specifier: `fixture:${packageName}`,
        metadata:
          packageName === request.package
            ? { name: request.package, version: request.version }
            : { name: secondPackage, version: secondVersion },
      })),
      importModule: vi.fn(async (specifier: string) =>
        fixtureModule(specifier.endsWith(secondPackage) ? secondPlugin : channelPluginPackage.channelPlugin),
      ),
    };
    class FailingSecondRegistry extends ChannelPluginRegistry {
      private registrations = 0;

      override register(plugin: ChannelPlugin): void {
        this.registrations += 1;
        if (this.registrations === 2) throw new Error('injected registry failure');
        super.register(plugin);
      }
    }
    const registry = new FailingSecondRegistry();
    const external = loader({
      registry,
      source,
      trustedPackages: [
        trust,
        { package: secondPackage, version: secondVersion, pluginId: secondId },
      ],
    });

    await expect(
      external.load([request, { package: secondPackage, version: secondVersion }]),
    ).rejects.toThrow(/injected registry failure/);
    expect(registry.get(NOOP_EXTERNAL_CHANNEL_PLUGIN_ID)).toBeUndefined();
    expect(registry.get(secondId)).toBeUndefined();
    expect(external.list()).toEqual([]);
  });

  it('supports clean package rollback after plugin startup failure', async () => {
    const failingPlugin = pluginWith({}, { start: async () => Promise.reject(new Error('start failed')) });
    const registry = new ChannelPluginRegistry();
    const external = loader({
      registry,
      source: fixtureSource({ module: fixtureModule(failingPlugin) }),
    });
    await external.load([request], [fixtureInstance()]);
    await expect(
      registry.start(NOOP_EXTERNAL_CHANNEL_PLUGIN_ID, runtimeContext()),
    ).rejects.toThrow(/start failed/);
    expect(registry.activeCount(NOOP_EXTERNAL_CHANNEL_PLUGIN_ID)).toBe(0);
    expect(external.unloadAll()).toHaveLength(1);
  });

  it('preflights unloadAll atomically before removing any registration', async () => {
    const secondPackage = '@fixture/aria-channel-second';
    const secondVersion = '2.0.0';
    const secondId = 'second-fixture';
    const secondPlugin = pluginWith({
      id: secondId,
      package: { name: secondPackage, version: secondVersion },
    });
    const source: ExternalChannelPluginPackageSource = {
      resolve: async (packageName) => ({
        specifier: `fixture:${packageName}`,
        metadata:
          packageName === request.package
            ? { name: request.package, version: request.version }
            : { name: secondPackage, version: secondVersion },
      }),
      importModule: async (specifier) =>
        fixtureModule(
          specifier.endsWith(secondPackage)
            ? secondPlugin
            : channelPluginPackage.channelPlugin,
        ),
    };
    const registry = new ChannelPluginRegistry();
    const external = loader({
      registry,
      source,
      trustedPackages: [
        trust,
        { package: secondPackage, version: secondVersion, pluginId: secondId },
      ],
    });
    await external.load([
      request,
      { package: secondPackage, version: secondVersion },
    ]);
    const runtime = await registry.start(NOOP_EXTERNAL_CHANNEL_PLUGIN_ID, runtimeContext());

    expect(() => external.unloadAll()).toThrowError(
      expect.objectContaining({ code: 'active-channel-plugin-unload-denied' }),
    );
    expect(registry.get(NOOP_EXTERNAL_CHANNEL_PLUGIN_ID)).toBeDefined();
    expect(registry.get(secondId)).toBeDefined();
    expect(external.list()).toHaveLength(2);

    await runtime.close();
    expect(external.unloadAll().map((entry) => entry.pluginId)).toEqual([
      secondId,
      NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
    ]);
  });

  it('blocks unload while plugin startup is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const baseStart = channelPluginPackage.channelPlugin.start;
    const delayedPlugin = pluginWith({}, {
      start: async (context) => {
        await gate;
        return baseStart(context);
      },
    });
    const registry = new ChannelPluginRegistry();
    const external = loader({
      registry,
      source: fixtureSource({ module: fixtureModule(delayedPlugin) }),
    });
    await external.load([request], [fixtureInstance()]);

    const start = registry.start(NOOP_EXTERNAL_CHANNEL_PLUGIN_ID, runtimeContext());
    expect(() => external.unloadAll()).toThrowError(
      expect.objectContaining({ code: 'active-channel-plugin-unload-denied' }),
    );
    release();
    const runtime = await start;
    await runtime.close();
    expect(external.unloadAll()).toHaveLength(1);
  });

  it('reads installed package metadata without importing the package', async () => {
    const source = new InstalledChannelPluginPackageSource();
    const resolved = await source.resolve('vitest');
    expect(resolved.specifier).toBe('vitest');
    expect(resolved.metadata).toMatchObject({ name: 'vitest' });
  });
});
