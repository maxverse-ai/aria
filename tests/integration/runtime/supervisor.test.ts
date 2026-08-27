import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { Supervisor } from '../../../src/runtime/supervisor';
import { registerEnginePlugin } from '../../../src/agent/plugin/registry';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { readRuntimeLockMeta } from '../../../src/runtime/locks';
import { readAndPrune } from '../../../src/runtime/registry';

const roots: string[] = [];
const started: string[] = [];
const disconnected: string[] = [];
const startedAgents: string[] = [];
const createdAgents: string[] = [];
const disposedAgents: string[] = [];
let quiesceCount = 0;
let root: string;
let sup: Supervisor;
let failedAgent: string | undefined;
let blockedAgent: string | undefined;
let releaseBlockedAgent: (() => void) | undefined;

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

beforeEach(async () => {
  started.length = 0;
  disconnected.length = 0;
  startedAgents.length = 0;
  createdAgents.length = 0;
  disposedAgents.length = 0;
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
  });

  it('hosts multiple profiles at once', async () => {
    await sup.startProfile('claude');
    await sup.startProfile('work');
    expect(sup.list().map((s) => s.profile).sort()).toEqual(['claude', 'work']);
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
    const result = await controls.switchAgent!('switch-test');

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

    await sup.stopProfile('claude');
    expect(disposedAgents).toEqual(['switch-test']);
  });

  it('keeps the previous engine and projections when candidate readiness fails', async () => {
    registerFakeEngine('switch-fail');
    failedAgent = 'switch-fail';
    await sup.startProfile('claude');

    await expect(sup.controlsFor('claude')!.switchAgent!('switch-fail')).rejects.toThrow();

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
      sup.controlsFor('claude')!.switchAgent!('switch-after-read-failure'),
    ).rejects.toThrow(/profile not found/);

    await saveRootConfig(saved!, configPath);
    await expect(
      sup.controlsFor('claude')!.switchAgent!('switch-after-read-failure'),
    ).resolves.toMatchObject({ currentAgentKind: 'switch-after-read-failure' });
  });

  it('shares a same-target switch and rejects a conflicting target while it is in flight', async () => {
    registerFakeEngine('switch-slow');
    registerFakeEngine('switch-conflict');
    blockedAgent = 'switch-slow';
    await sup.startProfile('claude');

    const controls = sup.controlsFor('claude')!;
    const first = controls.switchAgent!('switch-slow');
    await expect.poll(() => createdAgents.filter((id) => id === 'switch-slow').length).toBe(1);
    const sameTarget = controls.switchAgent!('switch-slow');
    await expect(controls.switchAgent!('switch-conflict')).rejects.toThrow(
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
