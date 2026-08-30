import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import type { AgentAdapter } from '../../../src/agent/types.js';
import { defineEngineRuntimeDescriptor } from '../../../src/agent/runtime/types.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import type { EnginePlugin } from '../../../src/agent/plugin/types.js';
import {
  capabilityFor,
  createEngineRuntime,
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
    expect(ids).toContain('opencode');
    expect(ids).toContain('dsh');
    expect(ids).toContain('kimi');
    expect(ids).toContain('pi');
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
      const runtime = createEngineRuntime('ext-engine', {
        profileConfig: createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } }),
        appPaths: { profileDir: dir },
      });
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
