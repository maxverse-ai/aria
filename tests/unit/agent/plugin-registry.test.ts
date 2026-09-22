import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { resolveAppPaths, type AppPaths } from '../../../src/config/app-paths.js';
import { prepareProfileEngineRuntime } from '../../../src/runtime/agent-runtime.js';
import type { AgentAdapter } from '../../../src/agent/types.js';
import { defineEngineRuntimeDescriptor } from '../../../src/agent/runtime/types.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import type { EnginePlugin, EnginePluginContext } from '../../../src/agent/plugin/types.js';
import {
  capabilityFor,
  createEngineRuntime,
  prepareEngineRuntime,
  engineSupportsAutomation,
  engineProbes,
  getEnginePlugin,
  listEnginePlugins,
  loadExternalEnginePlugins,
  onEnginePluginEvent,
  registerEnginePlugin,
  requireEnginePlugin,
  unloadEnginePlugin,
} from '../../../src/agent/plugin/registry.js';

const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

describe('engine plugin registry', () => {
  it('registers the built-in claude and codex plugins', () => {
    const ids = listEnginePlugins().map((plugin) => plugin.id);
    expect(ids).toContain('claude');
    expect(ids).toContain('codex');
    expect(ids).toContain('grok');
    expect(ids).toContain('opencode');
    expect(ids).toContain('mimo');
    expect(ids).toContain('dsh');
    expect(ids).toContain('kimi');
    expect(ids).toContain('pi');
    expect(ids).toContain('devin');
  });

  it('requires each engine plugin to opt in to scheduled-trigger automation', () => {
    expect(engineSupportsAutomation('codex', 'scheduled-triggers')).toBe(true);
    expect(engineSupportsAutomation('claude', 'scheduled-triggers')).toBe(false);
  });

  it('resolves capability and managed runtime through a plugin', async () => {
    const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });

    const capability = capabilityFor('claude', profile);
    expect(capability.agentId).toBe('claude');
    expect(capability.sessionKind).toBe('claude-session');

    const runtime = createEngineRuntime('claude', {
      profileConfig: profile,
      appPaths: { profileDir: '/tmp/aria' },
    });
    expect(runtime.engineId).toBe('claude');
    expect(runtime.execution.id).toBe('claude');
    await runtime.dispose();
  });

  it('prepares an external v1 plugin with independent compatible inputs for each instance', async () => {
    const id = 'external-prepared-inputs';
    const seen: EnginePluginContext[] = [];
    registerEnginePlugin({
      ...requireEnginePlugin('claude'),
      id,
      createRuntime: (ctx) => {
        seen.push(structuredClone(ctx));
        // v1 never required immutable input. A plugin may mutate its own copy.
        ctx.profileConfig.access.allowedUsers.push('plugin-local-user');
        ctx.appPaths.profileDir = '/plugin-local-state';
        return {
          engineId: id,
          descriptor: defineEngineRuntimeDescriptor({ engineId: id, topology: 'one-shot' }),
          execution: new FakeAgentAdapter({ id }),
          dispose: async () => undefined,
        };
      },
    });
    const input = {
      profileConfig: createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
      appPaths: { profileDir: '/original', extraPath: '/keep-v1-extra-path' },
      ariaChannel: { profile: 'original-channel' },
    };
    const original = structuredClone(input);
    const prepared = prepareEngineRuntime(id, input);
    expect(seen).toEqual([]);
    input.profileConfig.access.allowedUsers.push('later-user');
    input.appPaths.profileDir = '/changed';
    input.ariaChannel.profile = 'changed';
    const first = prepared.create();
    const second = prepared.create();
    try {
      expect(seen).toEqual([original, original]);
      expect(Object.keys(seen[0]!).sort()).toEqual(['appPaths', 'ariaChannel', 'profileConfig']);
      expect(input.profileConfig.access.allowedUsers).not.toContain('plugin-local-user');
      expect(prepared.context.state.directory).toBe('/original');
      expect(first.execution).not.toBe(second.execution);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it('preserves callable AppPaths helpers and snapshots nested path data for external plugins', async () => {
    const id = 'external-prepared-path-helpers';
    const paths = resolveAppPaths({ rootDir: '/original', profile: 'fixture' });
    const expectedLockPath = paths.appLockFile('app-fixture');
    const originalStateRoot = paths.roots.stateRoot;
    registerEnginePlugin({
      ...requireEnginePlugin('claude'),
      id,
      createRuntime: (ctx) => {
        const projected = ctx.appPaths as AppPaths;
        expect(projected.appLockFile('app-fixture')).toBe(expectedLockPath);
        expect(projected.roots.stateRoot).toBe(originalStateRoot);
        projected.roots.stateRoot = '/plugin-local-root';
        return {
          engineId: id,
          descriptor: defineEngineRuntimeDescriptor({ engineId: id, topology: 'one-shot' }),
          execution: new FakeAgentAdapter({ id }),
          dispose: async () => undefined,
        };
      },
    });
    const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
    profile.agentKind = id;
    const prepared = prepareProfileEngineRuntime(profile, paths);
    paths.roots.stateRoot = '/changed-after-preparation';
    const first = prepared.create();
    const second = prepared.create();
    await first.dispose();
    await second.dispose();
    expect(paths.roots.stateRoot).toBe('/changed-after-preparation');
  });

  it('exposes plugin probes for first-run agent detection', () => {
    const probes = engineProbes();
    expect(probes).toContainEqual(
      expect.objectContaining({
        id: 'codex',
        probe: expect.objectContaining({ command: 'codex' }),
      }),
    );
  });

  it('registers a fake third-party plugin and resolves it', () => {
    const fakeAdapter: AgentAdapter = {
      id: 'fake-engine',
      displayName: 'Fake Engine',
      isAvailable: async () => true,
      run: () => ({
        runId: 'fake-run',
        events: {
          async *[Symbol.asyncIterator]() {
            /* no events */
          },
        },
        stop: async () => undefined,
        waitForExit: async () => true,
      }),
    };
    const fakePlugin: EnginePlugin = {
      id: 'fake-engine',
      displayName: 'Fake Engine',
      sessionKind: 'fake-session',
      supportsNativeHistory: false,
      probes: [{ command: 'fake-cli', envKey: 'LARK_CHANNEL_FAKE_BIN' }],
      capability: (profile) => ({
        agentId: 'fake-engine',
        sessionKind: 'fake-session',
        promptInjection: 'stdin-prefix',
        systemPrompt: '',
        supportsNativeHistory: false,
        callback: { marker: '__bridge_cb', legacyMarkers: [] },
        permissions: { maxAccess: profile.permissions.maxAccess },
      }),
      createRuntime: () => ({
        engineId: 'fake-engine',
        descriptor: defineEngineRuntimeDescriptor({
          engineId: 'fake-engine',
          topology: 'one-shot',
        }),
        execution: fakeAdapter,
        dispose: async () => undefined,
      }),
    };

    registerEnginePlugin(fakePlugin);

    expect(getEnginePlugin('fake-engine')?.displayName).toBe('Fake Engine');
    expect(requireEnginePlugin('fake-engine')).toBe(fakePlugin);
  });

  it('throws for unknown engine ids', () => {
    expect(() => requireEnginePlugin('missing-engine')).toThrow(/unsupported agent engine/);
  });

  it('rejects unknown automation capabilities at the dynamic plugin boundary', () => {
    expect(() => registerEnginePlugin({
      id: 'unsafe-automation',
      displayName: 'Unsafe',
      sessionKind: 'unsafe',
      supportsNativeHistory: false,
      automationCapabilities: ['shell-root' as 'scheduled-triggers'],
      probes: [],
      capability: () => { throw new Error('unused'); },
      createRuntime: () => { throw new Error('unused'); },
    })).toThrow(/invalid engine plugin automation capability/);
  });

  it('rejects a runtime descriptor owned by another engine', () => {
    const id = 'invalid-runtime-descriptor';
    registerEnginePlugin({
      id,
      displayName: 'Invalid Runtime Descriptor',
      sessionKind: 'invalid-session',
      supportsNativeHistory: false,
      probes: [],
      capability: (profile) => ({
        agentId: id,
        sessionKind: 'invalid-session',
        promptInjection: 'stdin-prefix',
        systemPrompt: '',
        supportsNativeHistory: false,
        callback: { marker: '__bridge_cb', legacyMarkers: [] },
        permissions: { maxAccess: profile.permissions.maxAccess },
      }),
      createRuntime: () => ({
        engineId: id,
        descriptor: defineEngineRuntimeDescriptor({
          engineId: 'another-engine',
          topology: 'one-shot',
        }),
        execution: new FakeAgentAdapter({ id }),
        dispose: async () => undefined,
      }),
    });

    expect(() => createEngineRuntime(id, {
      profileConfig: createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
      appPaths: { profileDir: '/tmp/aria' },
    })).toThrow(/invalid runtime.*does not match/);
  });

  it('loads and unloads an external engine plugin package', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'engine-plugin-ext-'));
    const modulePath = join(dir, 'index.mjs');
    await writeFile(
      modulePath,
      [
        "export const enginePlugin = {",
        "  id: 'ext-engine',",
        "  displayName: 'Ext Engine',",
        "  sessionKind: 'ext-session',",
        "  supportsNativeHistory: false,",
        "  probes: [],",
        "  capability: (p) => ({",
        "    agentId: 'ext-engine',",
        "    sessionKind: 'ext-session',",
        "    promptInjection: 'stdin-prefix',",
        "    systemPrompt: '',",
        "    supportsNativeHistory: false,",
        "    callback: { marker: '__bridge_cb', legacyMarkers: [] },",
        "    permissions: { maxAccess: p.permissions.maxAccess },",
        "  }),",
        "  createRuntime: () => ({",
        "    engineId: 'ext-engine',",
        "    execution: {",
        "      id: 'ext-engine',",
        "      displayName: 'Ext Engine',",
        "      isAvailable: async () => true,",
        "      run: () => ({",
        "        runId: '',",
        "        events: { async *[Symbol.asyncIterator]() {} },",
        "        stop: async () => undefined,",
        "        waitForExit: async () => true,",
        "      }),",
        "    },",
        "    dispose: async () => undefined,",
        "  }),",
        "};",
      ].join('\n'),
    );

    try {
      // Keep the specifier as a normalized filesystem path. On Windows runners,
      // pathToFileURL percent-encodes the 8.3 temp-directory tilde and Vite then
      // looks for the encoded path instead of the real file.
      const loaded = await loadExternalEnginePlugins([modulePath.replaceAll('\\', '/')]);
      expect(loaded).toEqual(['ext-engine']);
      expect(getEnginePlugin('ext-engine')?.displayName).toBe('Ext Engine');
      const prepared = prepareEngineRuntime('ext-engine', {
        profileConfig: createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
        appPaths: { profileDir: dir },
      });
      const runtime = prepared.create();
      expect(runtime.descriptor).toMatchObject({
        contractVersion: 1,
        engineId: 'ext-engine',
        topology: 'one-shot',
        capabilities: { liveInput: { mode: 'none' } },
      });

      const events: string[] = [];
      const off = onEnginePluginEvent((event) => events.push(`${event.type}:${event.id}`));
      try {
        expect(() => unloadEnginePlugin('ext-engine')).toThrow(/active engine plugin/);
        await runtime.dispose();
        await runtime.dispose();
        expect(unloadEnginePlugin('ext-engine')).toBe(true);
        expect(getEnginePlugin('ext-engine')).toBeUndefined();
        expect(() => prepared.create()).toThrow(/unsupported agent engine/);
        expect(events).toContain('unloaded:ext-engine');
        expect(unloadEnginePlugin('ext-engine')).toBe(false);
      } finally {
        off();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a duplicate engine id', () => {
    const original = getEnginePlugin('claude');
    expect(original).toBeDefined();
    expect(() => registerEnginePlugin({ ...original! })).toThrow(/already registered/);
  });
});
