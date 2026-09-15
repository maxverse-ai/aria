import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { Supervisor } from '../../../src/runtime/supervisor';
import { registerEnginePlugin } from '../../../src/agent/plugin/registry';
import { defineEngineRuntimeDescriptor } from '../../../src/agent/runtime/types';
import { migrateRootConfigToSchemaV3 } from '../../../src/config/channel-schema-migration';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { readRuntimeLockMeta } from '../../../src/runtime/locks';
import { readAndPrune } from '../../../src/runtime/registry';
import type { ControlActorContext } from '../../../src/application/control';
import type { ProfileConversationRuntimeOwner } from '../../../src/conversation/profile-runtime-owner';
import type { ExternalChannelPluginPackageSource } from '../../../src/channel/plugin/loader';
import type { ChannelPlugin } from '../../../src/channel/plugin/types';
import {
  channelPluginPackage,
  NOOP_EXTERNAL_CHANNEL_PACKAGE,
  NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
  NOOP_EXTERNAL_CHANNEL_VERSION,
} from '../../fixtures/channel/noop-external-channel-plugin';

const roots: string[] = [];
const started: string[] = [];
const disconnected: string[] = [];
const startedAgents: string[] = [];
const createdAgents: string[] = [];
const disposedAgents: string[] = [];
const startedConversationRuntimes: ProfileConversationRuntimeOwner[] = [];
let quiesceCount = 0;
let root: string;
let sup: Supervisor;
let failedAgent: string | undefined;
let blockedAgent: string | undefined;
let releaseBlockedAgent: (() => void) | undefined;
const actor: ControlActorContext = { source: 'agent', principal: 'ou-engine-admin' };
const externalRequest = Object.freeze({
  package: NOOP_EXTERNAL_CHANNEL_PACKAGE,
  version: NOOP_EXTERNAL_CHANNEL_VERSION,
});
const externalTrust = Object.freeze({
  ...externalRequest,
  pluginId: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
});

function app(id: string) {
  return { id, secret: '${APP_SECRET}', tenant: 'feishu' as const };
}

function registerFakeEngine(id: string): void {
  registerEnginePlugin({
    id,
    displayName: id,
    sessionKind: `${id}-session`,
    supportsNativeHistory: false,
    probes: [],
    capability: (profile) => ({
      agentId: id,
      sessionKind: `${id}-session`,
      promptInjection: 'stdin-prefix',
      systemPrompt: '',
      supportsNativeHistory: false,
      callback: { marker: '__bridge_cb', legacyMarkers: [] },
      permissions: { maxAccess: profile.permissions.maxAccess },
    }),
    createRuntime: () => {
      createdAgents.push(id);
      const execution = new FakeAgentAdapter({ id, displayName: id });
      execution.isAvailable = async () => {
        if (id === blockedAgent) {
          await new Promise<void>((resolve) => {
            releaseBlockedAgent = resolve;
          });
        }
        return id !== failedAgent;
      };
      return {
        engineId: id,
        descriptor: defineEngineRuntimeDescriptor({ engineId: id, topology: 'one-shot' }),
        execution,
        dispose: async () => {
          disposedAgents.push(id);
        },
      };
    },
  });
}

// Stub startChannel — no network, records lifecycle, returns a minimal bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const stubStartChannel: any = async (deps: any) => {
  started.push(deps.appPaths.profile);
  startedAgents.push(deps.agent.id);
  startedConversationRuntimes.push(deps.conversationRuntime);
  return {
    channel: { botIdentity: { name: `bot-${deps.appPaths.profile}` } },
    quiesceAgentRuns: async () => {
      quiesceCount++;
      return () => undefined;
    },
    disconnect: async () => {
      disconnected.push(deps.appPaths.profile);
    },
  };
};

function externalSource(
  plugin: ChannelPlugin = channelPluginPackage.channelPlugin,
): ExternalChannelPluginPackageSource {
  return {
    resolve: vi.fn(async () => ({
      specifier: 'fixture:noop-channel',
      metadata: { name: externalRequest.package, version: externalRequest.version },
    })),
    importModule: vi.fn(async () => ({ channelPluginPackage: { channelPlugin: plugin } })),
  };
}

async function storeExternalChannel(): Promise<void> {
  const configPath = join(root, 'config.json');
  const current = (await loadRootConfig(configPath))!;
  const migrated = migrateRootConfigToSchemaV3(current);
  const profile = migrated.profiles.claude!;
  profile.channels = {
    plugins: [externalRequest],
    instances: {
      ...profile.channels!.instances,
      'fixture-primary': {
        plugin: NOOP_EXTERNAL_CHANNEL_PLUGIN_ID,
        enabled: true,
        configVersion: 1,
        config: { label: 'Supervisor fixture' },
        secretRefs: {},
      },
    },
  };
  await saveRootConfig(migrated, configPath);
}

beforeEach(async () => {
  started.length = 0;
  disconnected.length = 0;
  startedAgents.length = 0;
  createdAgents.length = 0;
  disposedAgents.length = 0;
  startedConversationRuntimes.length = 0;
  quiesceCount = 0;
  failedAgent = undefined;
  blockedAgent = undefined;
  releaseBlockedAgent = undefined;
  root = await mkdtemp(join(tmpdir(), 'bridge-sup-'));
  roots.push(root);
  const configPath = join(root, 'config.json');

  // claude (cli_a), work (cli_b), dup (cli_b — same app as work).
  await mkdir(join(root, 'profiles', 'claude'), { recursive: true });
  await saveRootConfig(
    createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: app('cli_a') } })),
    configPath,
  );
  const rc = (await loadRootConfig(configPath))!;
  for (const [name, id] of [['work', 'cli_b'], ['dup', 'cli_b']] as const) {
    await mkdir(join(root, 'profiles', name), { recursive: true });
    rc.profiles[name] = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: app(id) } });
  }
  await saveRootConfig(rc, configPath);

  sup = new Supervisor({ configPath, rootDir: root, runPreflight: false, startChannelFn: stubStartChannel });
});

afterEach(async () => {
  await sup.shutdown();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('Supervisor', () => {
  it.each(['shadow', 'opt-in'] as const)(
    'projects schema-v2 channel instances without rewriting profile config in %s mode',
    async (mode) => {
      sup = new Supervisor({
        configPath: join(root, 'config.json'),
        rootDir: root,
        runPreflight: false,
        startChannelFn: stubStartChannel,
        larkChannelRolloutMode: mode,
      });
      const configPath = join(root, 'config.json');
      const before = await readFile(configPath, 'utf8');

      await sup.startProfile('claude');
      await sup.stopProfile('claude');

      expect(await readFile(configPath, 'utf8')).toBe(before);
    },
  );

  it('starts, reconnects, and stops from stored schema v3 without rewriting it', async () => {
    registerFakeEngine('schema-v3-reconnect-test');
    const configPath = join(root, 'config.json');
    const current = (await loadRootConfig(configPath))!;
    current.profiles.claude!.agentKind = 'schema-v3-reconnect-test';
    const migrated = migrateRootConfigToSchemaV3(current);
    await saveRootConfig(migrated, configPath);
    const before = await readFile(configPath, 'utf8');

    sup = new Supervisor({
      configPath,
      rootDir: root,
      runPreflight: false,
      startChannelFn: stubStartChannel,
      larkChannelRolloutMode: 'opt-in',
    });

    await sup.startProfile('claude');
    await sup.restartProfile('claude');
    await sup.stopProfile('claude');

    expect(started).toEqual(['claude', 'claude']);
    expect(disconnected).toEqual(['claude', 'claude']);
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect((await loadRootConfig(configPath))?.schemaVersion).toBe(3);
  });

  it('keeps stored external channels inactive without explicit deployment composition', async () => {
    await storeExternalChannel();
    const configPath = join(root, 'config.json');
    const before = await readFile(configPath, 'utf8');

    await sup.startProfile('claude');

    expect(sup.externalChannelsFor('claude')).toBeUndefined();
    expect(sup.list()[0]).toMatchObject({
      externalChannelPluginCount: 0,
      externalChannelInstanceCount: 0,
    });
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  it('owns an explicitly trusted external plugin across start, Lark reconnect, and stop', async () => {
    registerFakeEngine('external-lifecycle-test');
    const configPath = join(root, 'config.json');
    const config = (await loadRootConfig(configPath))!;
    config.profiles.claude!.agentKind = 'external-lifecycle-test';
    await saveRootConfig(config, configPath);
    await storeExternalChannel();
    const lifecycle: string[] = [];
    const base = channelPluginPackage.channelPlugin;
    const plugin: ChannelPlugin = {
      ...base,
      async start(context) {
        lifecycle.push(`start:${context.instance.instanceId}`);
        const runtime = await base.start(context);
        return {
          ...runtime,
          close: async () => {
            lifecycle.push(`close:${context.instance.instanceId}`);
            await runtime.close();
          },
        };
      },
    };
    sup = new Supervisor({
      configPath,
      rootDir: root,
      runPreflight: false,
      startChannelFn: stubStartChannel,
      externalChannelPlugins: {
        trustedPackages: [externalTrust],
        source: externalSource(plugin),
        createIngress: () => ({
          accept: async () => ({ status: 'accepted', receiptId: 'supervisor-fixture' }),
        }),
      },
    });

    await sup.startProfile('claude');
    expect(sup.externalChannelsFor('claude')).toMatchObject({
      loadedPlugins: [externalTrust],
      manager: { state: 'ready', instanceCount: 1, readyCount: 1 },
    });
    expect(sup.list()[0]).toMatchObject({
      externalChannelPluginCount: 1,
      externalChannelInstanceCount: 1,
    });

    await sup.restartProfile('claude');
    expect(lifecycle).toEqual(['start:fixture-primary']);
    await sup.stopProfile('claude');
    expect(lifecycle).toEqual(['start:fixture-primary', 'close:fixture-primary']);
    expect(sup.externalChannelsFor('claude')).toBeUndefined();
  });

  it('rolls back the profile when external desired state is not deployment-trusted', async () => {
    await storeExternalChannel();
    sup = new Supervisor({
      configPath: join(root, 'config.json'),
      rootDir: root,
      runPreflight: false,
      startChannelFn: stubStartChannel,
      externalChannelPlugins: {
        trustedPackages: [],
        source: externalSource(),
        createIngress: () => ({
          accept: async () => ({ status: 'accepted', receiptId: 'supervisor-fixture' }),
        }),
      },
    });

    await sup.startProfile('work');
    await expect(sup.startProfile('claude')).rejects.toMatchObject({
      code: 'untrusted-channel-plugin-package',
    });
    expect(sup.isOnline('claude')).toBe(false);
    expect(sup.isOnline('work')).toBe(true);
    expect(started).toEqual(['work', 'claude']);
    expect(disconnected).toEqual(['claude']);
  });

  it('rejects Lark reconnect when external desired state changed behind the live owner', async () => {
    await storeExternalChannel();
    const configPath = join(root, 'config.json');
    sup = new Supervisor({
      configPath,
      rootDir: root,
      runPreflight: false,
      startChannelFn: stubStartChannel,
      externalChannelPlugins: {
        trustedPackages: [externalTrust],
        source: externalSource(),
        createIngress: () => ({
          accept: async () => ({ status: 'accepted', receiptId: 'supervisor-fixture' }),
        }),
      },
    });
    await sup.startProfile('claude');
    const changed = structuredClone((await loadRootConfig(configPath))!);
    const stored = changed.profiles.claude!.channels!.instances['fixture-primary']!;
    changed.profiles.claude!.channels!.instances = {
      ...changed.profiles.claude!.channels!.instances,
      'fixture-primary': { ...stored, config: { label: 'Changed while live' } },
    };
    await saveRootConfig(changed, configPath);

    await expect(sup.restartProfile('claude')).rejects.toMatchObject({
      code: 'external-channel-reconcile-required',
    });
    expect(disconnected).toEqual([]);
    expect(sup.externalChannelsFor('claude')).toMatchObject({
      manager: { state: 'ready', instanceCount: 1 },
    });
  });

  it.each([
    ['off', 'legacy'],
    ['shadow', 'legacy'],
    ['opt-in', 'manager'],
    ['default-on', 'manager'],
  ] as const)('keeps one Lark transport owner in %s rollout mode', async (mode, owner) => {
    sup = new Supervisor({
      configPath: join(root, 'config.json'),
      rootDir: root,
      runPreflight: false,
      startChannelFn: stubStartChannel,
      larkChannelRolloutMode: mode,
    });

    await sup.startProfile('claude');
    expect(started).toEqual(['claude']);
    expect(sup.list()[0]).toMatchObject({
      larkChannelRolloutMode: mode,
      larkChannelOwner: owner,
    });

    await sup.stopProfile('claude');
    expect(disconnected).toEqual(['claude']);
  });

  it('reconnects an opt-in manager-owned Lark bridge without leaking either transport', async () => {
    registerFakeEngine('manager-reconnect-test');
    const configPath = join(root, 'config.json');
    const config = (await loadRootConfig(configPath))!;
    config.profiles.claude!.agentKind = 'manager-reconnect-test';
    await saveRootConfig(config, configPath);

    sup = new Supervisor({
      configPath,
      rootDir: root,
      runPreflight: false,
      startChannelFn: stubStartChannel,
      larkChannelRolloutMode: 'opt-in',
    });

    await sup.startProfile('claude');
    const owner = startedConversationRuntimes[0];
    await sup.restartProfile('claude');

    expect(started).toEqual(['claude', 'claude']);
    expect(disconnected).toEqual(['claude']);
    expect(startedConversationRuntimes).toEqual([owner, owner]);
    expect(sup.list()[0]).toMatchObject({ larkChannelOwner: 'manager' });

    await sup.stopProfile('claude');
    expect(disconnected).toEqual(['claude', 'claude']);
  });

  it('keeps native read disabled by default and owns an explicitly supplied lifecycle', async () => {
    const lifecycle: string[] = [];
    sup = new Supervisor({
      configPath: join(root, 'config.json'), rootDir: root, runPreflight: false,
      startChannelFn: stubStartChannel,
      createNativeReadRuntime: ({ profile }) => ({
        audit: undefined as never,
        runAudit: undefined as never,
        messageAudit: undefined as never,
        messageRead: undefined as never,
        governanceAudit: undefined as never,
        start: async () => { lifecycle.push(`start:${profile}`); },
        refreshSessions: async () => undefined,
        stop: async () => { lifecycle.push(`stop:${profile}`); },
      }),
    });

    await sup.startProfile('claude');
    await sup.stopProfile('claude');
    expect(lifecycle).toEqual(['start:claude', 'stop:claude']);
  });

  it('starts a profile in-process and lists it online', async () => {
    await sup.startProfile('claude');
    expect(sup.isOnline('claude')).toBe(true);
    expect(started).toContain('claude');
    const list = sup.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ profile: 'claude', online: true, pid: process.pid, botName: 'bot-claude' });
    expect(startedConversationRuntimes[0]?.profileId).toBe('claude');
  });

  it('hosts multiple profiles at once', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('work');
    expect(sup.list().map((s) => s.profile).sort()).toEqual(['claude', 'work']);
    expect(startedConversationRuntimes[0]).not.toBe(startedConversationRuntimes[1]);
  });

  it('reuses one profile conversation runtime across reconnect', async () => {
    registerFakeEngine('reconnect-test');
    const configPath = join(root, 'config.json');
    const config = (await loadRootConfig(configPath))!;
    config.profiles.claude!.agentKind = 'reconnect-test';
    await saveRootConfig(config, configPath);

    await sup.startProfile('claude');
    const owner = startedConversationRuntimes[0];

    await sup.restartProfile('claude');

    expect(startedConversationRuntimes).toEqual([owner, owner]);
    expect(startedAgents).toEqual(['reconnect-test', 'reconnect-test']);
    expect(quiesceCount).toBe(1);
    expect(disconnected).toEqual(['claude']);
    expect(owner?.isClosed()).toBe(false);

    await sup.stopProfile('claude');
    expect(owner?.isClosed()).toBe(true);
  });

  it('stops one profile without affecting others or the process', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('work');
    await sup.stopProfile('claude');
    expect(sup.isOnline('claude')).toBe(false);
    expect(disconnected).toContain('claude');
    expect(sup.isOnline('work')).toBe(true); // supervisor + other profile still up
  });

  it('refuses to bring up two profiles sharing one app id', async () => {
    await sup.startProfile('work'); // cli_b
    await expect(sup.startProfile('dup')).rejects.toThrow(/已被 profile/);
    expect(sup.isOnline('dup')).toBe(false);
  });

  it('startProfile is idempotent', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('claude');
    expect(started.filter((p) => p === 'claude')).toHaveLength(1);
  });

  it('switches an engine transactionally and synchronizes every runtime projection', async () => {
    registerFakeEngine('switch-test');

    await sup.startProfile('claude');
    const controls = sup.controlsFor('claude')!;
    const result = await controls.switchAgent!('switch-test', actor);

    expect(result).toMatchObject({
      changed: true,
      previousAgentKind: 'claude',
      currentAgentKind: 'switch-test',
    });
    expect(startedAgents).toEqual(['claude']);
    expect(createdAgents).toContain('switch-test');
    expect(quiesceCount).toBe(1);
    expect(disconnected).toEqual([]);
    expect(sup.controlsFor('claude')).toBe(controls);
    expect(controls.profileConfig.agentKind).toBe('switch-test');
    expect(sup.list()[0]?.agentKind).toBe('switch-test');

    const configPath = join(root, 'config.json');
    expect((await loadRootConfig(configPath))?.profiles.claude?.agentKind).toBe('switch-test');
    const paths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    expect((await readRuntimeLockMeta(paths.profileLockFile))?.agentKind).toBe('switch-test');
    expect((await readRuntimeLockMeta(paths.appLockFile('cli_a')))?.agentKind).toBe('switch-test');
    expect(readAndPrune(paths.userRegistryFile)[0]?.agentKind).toBe('switch-test');
    const plans = (await readdir(join(root, 'control', 'plans')))
      .filter((name) => name.endsWith('.json'));
    expect(plans).toHaveLength(1);
    expect(await readFile(join(root, 'control', 'plans', plans[0]!), 'utf8')).toContain(
      '"id": "profile.engine.update"',
    );

    await sup.stopProfile('claude');
    expect(disposedAgents).toEqual(['switch-test']);
  });

  it('reuses the manager-owned Lark transport during an opt-in engine switch', async () => {
    registerFakeEngine('manager-switch-test');
    sup = new Supervisor({
      configPath: join(root, 'config.json'),
      rootDir: root,
      runPreflight: false,
      startChannelFn: stubStartChannel,
      larkChannelRolloutMode: 'opt-in',
    });

    await sup.startProfile('claude');
    await expect(
      sup.controlsFor('claude')!.switchAgent!('manager-switch-test', actor),
    ).resolves.toMatchObject({ currentAgentKind: 'manager-switch-test' });

    expect(started).toEqual(['claude']);
    expect(disconnected).toEqual([]);
    expect(sup.list()[0]).toMatchObject({
      agentKind: 'manager-switch-test',
      larkChannelOwner: 'manager',
    });
  });

  it('keeps the previous engine and projections when candidate readiness fails', async () => {
    registerFakeEngine('switch-fail');
    failedAgent = 'switch-fail';
    await sup.startProfile('claude');

    await expect(
      sup.controlsFor('claude')!.switchAgent!('switch-fail', actor),
    ).rejects.toThrow();

    const paths = resolveAppPaths({ rootDir: root, profile: 'claude' });
    expect(sup.list()[0]?.agentKind).toBe('claude');
    expect((await loadRootConfig(join(root, 'config.json')))?.profiles.claude?.agentKind).toBe('claude');
    expect((await readRuntimeLockMeta(paths.profileLockFile))?.agentKind).toBe('claude');
    expect((await readRuntimeLockMeta(paths.appLockFile('cli_a')))?.agentKind).toBe('claude');
    expect(readAndPrune(paths.userRegistryFile)[0]?.agentKind).toBe('claude');
    expect(disposedAgents).toEqual(['switch-fail']);
  });

  it('releases the switch guard when loading the persisted profile fails', async () => {
    registerFakeEngine('switch-after-read-failure');
    await sup.startProfile('claude');
    const configPath = join(root, 'config.json');
    const saved = await loadRootConfig(configPath);
    expect(saved).toBeDefined();
    await rm(configPath);

    await expect(
      sup.controlsFor('claude')!.switchAgent!('switch-after-read-failure', actor),
    ).rejects.toThrow(/profile not found/);

    await saveRootConfig(saved!, configPath);
    await expect(
      sup.controlsFor('claude')!.switchAgent!('switch-after-read-failure', actor),
    ).resolves.toMatchObject({ currentAgentKind: 'switch-after-read-failure' });
  });

  it('shares a same-target switch and rejects a conflicting target while it is in flight', async () => {
    registerFakeEngine('switch-slow');
    registerFakeEngine('switch-conflict');
    blockedAgent = 'switch-slow';
    await sup.startProfile('claude');

    const controls = sup.controlsFor('claude')!;
    const first = controls.switchAgent!('switch-slow', actor);
    await expect.poll(() => createdAgents.filter((id) => id === 'switch-slow').length).toBe(1);
    const sameTarget = controls.switchAgent!('switch-slow', actor);
    await expect(controls.switchAgent!('switch-conflict', actor)).rejects.toThrow(
      /switch to switch-slow is already in progress/,
    );

    releaseBlockedAgent?.();
    await expect(Promise.all([first, sameTarget])).resolves.toEqual([
      expect.objectContaining({ currentAgentKind: 'switch-slow' }),
      expect.objectContaining({ currentAgentKind: 'switch-slow' }),
    ]);
    expect(createdAgents.filter((id) => id === 'switch-slow')).toHaveLength(1);
  });
});


describe('persistent Supervisor running intent', () => {
  function replacement() {
    return new Supervisor({ configPath: join(root, 'config.json'), rootDir: root,
      runPreflight: false, startChannelFn: stubStartChannel });
  }
  it('restores online profiles after shutdown and honors a stopped default', async () => {
    await sup.restoreProfiles('claude');
    await sup.startProfile('work');
    await sup.stopProfile('claude');
    await sup.shutdown();
    sup = replacement();
    await sup.restoreProfiles('claude');
    expect(sup.isOnline('work')).toBe(true);
    expect(sup.isOnline('claude')).toBe(false);
    await sup.stopProfile('work');
    await sup.shutdown();
    sup = replacement();
    await sup.restoreProfiles('claude');
    expect(sup.list()).toEqual([]);
  });
  it('serializes concurrent starts and same-app conflicts', async () => {
    await Promise.all([sup.startProfile('claude'), sup.startProfile('claude')]);
    expect(started.filter((p) => p === 'claude')).toHaveLength(1);
    const results = await Promise.allSettled([sup.startProfile('work'), sup.startProfile('dup')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
  });
  it('honors an explicit stop queued during startup restoration', async () => {
    await sup.startProfile('work');
    await sup.shutdown();
    sup = replacement();
    await Promise.all([sup.restoreProfiles('claude'), sup.stopProfile('work')]);
    expect(sup.isOnline('work')).toBe(false);
    await sup.shutdown();
    sup = replacement();
    await sup.restoreProfiles('claude');
    expect(sup.isOnline('work')).toBe(false);
  });
  it('does not enroll classic single-profile runs into global startup', async () => {
    await sup.shutdown();
    sup = new Supervisor({ configPath: join(root, 'config.json'), rootDir: root,
      runPreflight: false, startChannelFn: stubStartChannel, persistRunningIntent: false });
    await sup.startProfile('work');
    await sup.shutdown();
    sup = replacement();
    await sup.restoreProfiles('claude');
    expect(sup.isOnline('claude')).toBe(true);
    expect(sup.isOnline('work')).toBe(false);
  });
  it('continues restoring other profiles when one desired profile fails', async () => {
    await sup.startProfile('work');
    await expect(sup.startProfile('dup')).rejects.toThrow();
    await sup.startProfile('claude');
    await sup.shutdown();
    sup = replacement();
    await sup.restoreProfiles('claude');
    expect(sup.isOnline('claude')).toBe(true);
    expect(sup.isOnline('work')).toBe(true);
    expect(sup.isOnline('dup')).toBe(false);
  });
});
