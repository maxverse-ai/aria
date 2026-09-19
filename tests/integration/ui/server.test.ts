import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { migrateRootConfigToSchemaV3 } from '../../../src/config/channel-schema-migration';
import {
  createRootConfig,
  loadRootConfig,
  runtimeProfileConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';
import { startUiServer } from '../../../src/ui/server';
import type { UiServerHandle, UiSupervisor } from '../../../src/ui/types';

const app = { id: 'cli_test', secret: '${APP_SECRET}', tenant: 'feishu' as const };

const roots: string[] = [];
let handle: UiServerHandle;
let rootDir: string;
let configPath: string;
let base: string;
// profile -> controls (a MutableProfileState/Controls-ish object)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let online: Map<string, any>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function makeControls(profile: string): Promise<any> {
  const root = (await loadRootConfig(configPath))!;
  return {
    configPath,
    profile,
    cfg: runtimeProfileConfig(root, profile),
    profileConfig: root.profiles[profile]!,
    ownerRefreshState: 'unknown',
    processId: 'test',
    refreshOwner: async () => {},
    restart: vi.fn(async () => {}),
  };
}

function stubSupervisor(): UiSupervisor {
  return {
    isOnline: (p) => online.has(p),
    controlsFor: (p) => online.get(p),
    externalChannelsFor: () => undefined,
    channelFor: () => undefined,
    list: () =>
      [...online.keys()].map((p) => ({
        profile: p,
        agentKind: 'claude' as const,
        online: true,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        botName: `bot-${p}`,
        larkChannelRolloutMode: 'shadow' as const,
        larkChannelOwner: 'legacy' as const,
      })),
    startProfile: async (p) => {
      online.set(p, await makeControls(p));
    },
    stopProfile: async (p) => {
      online.delete(p);
    },
    restartProfile: async () => {},
    readTriggers: async () => ({
      schema: 'aria.trigger-read.snapshot.v1', apiVersion: 1,
      generatedAt: new Date().toISOString(), definitions: [], occurrences: [],
    }),
    previewTrigger: async (definitionId) => ({
      schema: 'aria.trigger-read.preview.v1', apiVersion: 1, definitionId,
      schedule: { kind: 'once', at: new Date(Date.now() + 60_000).toISOString() },
      timeZone: 'UTC', fireTimes: [],
    }),
    manageTrigger: async (command) => ({
      schema: 'aria.trigger-management.apply.v1', apiVersion: 1,
      requestId: 'request', planId: 'plan', command,
    }),
  };
}

function get(path: string, token?: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { headers: { ...(token ? { 'x-ui-token': token } : {}), ...headers } });
}
function post(path: string, token: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'x-ui-token': token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> {
  return res.json();
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'bridge-ui-'));
  roots.push(rootDir);
  configPath = join(rootDir, 'config.json');
  await mkdir(join(rootDir, 'profiles', 'claude'), { recursive: true });
  await saveRootConfig(
    createRootConfig('claude', createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } })),
    configPath,
  );
  // second profile 'work' on disk (offline)
  const rc = (await loadRootConfig(configPath))!;
  await mkdir(join(rootDir, 'profiles', 'work'), { recursive: true });
  rc.profiles.work = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { ...app, id: 'cli_work' } } });
  await saveRootConfig(rc, configPath);
  await writeActiveProfile(rootDir, 'claude');

  online = new Map();
  online.set('claude', await makeControls('claude')); // claude online, work offline

  handle = await startUiServer({ supervisor: stubSupervisor(), version: 'test', rootDir });
  base = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.close();
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

describe('ui server (supervisor-backed)', () => {
  it('rejects API calls without the token', async () => {
    expect((await get('/api/status')).status).toBe(401);
    expect((await get('/api/config', 'wrong-token-value')).status).toBe(401);
  });

  it('rejects cross-origin requests', async () => {
    const res = await get('/api/status', handle.token, { origin: 'http://evil.example.com' });
    expect(res.status).toBe(403);
  });

  it('accepts one exact configured reverse-proxy origin with an explicit token', async () => {
    await handle.close();
    const proxyToken = 'cd'.repeat(32);
    handle = await startUiServer({
      supervisor: stubSupervisor(),
      version: 'test',
      rootDir,
      token: proxyToken,
      allowedOrigins: ['https://console.example.com'],
    });
    base = `http://127.0.0.1:${handle.port}`;

    expect(handle.token).toBe(proxyToken);
    expect((await get('/api/status', proxyToken, { origin: 'https://console.example.com' })).status).toBe(200);
    expect((await get('/api/status', proxyToken, { origin: 'https://evil.console.example.com' })).status).toBe(403);
  });

  it('serves the console shell without a token', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('控制台');
  });

  it('returns status and config for the active (online) profile', async () => {
    const status = await json(await get('/api/status', handle.token));
    expect(status).toMatchObject({ hosted: true, version: 'test', activeProfile: 'claude', online: 1 });

    const config = await json(await get('/api/config', handle.token));
    expect(config.mode).toBe('personal');
    expect(config.live).toBe(true);
  });

  it('serves model snapshots immediately and starts refresh with 202', async () => {
    const snapshotResponse = await get('/api/models?profile=claude', handle.token);
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await json(snapshotResponse);
    expect(snapshot).toMatchObject({ profileId: 'claude', engineId: 'claude' });
    expect(snapshot.models[0]?.value).toBe('default');

    const refreshResponse = await post('/api/models?profile=claude', handle.token, {});
    expect(refreshResponse.status).toBe(202);
    expect(await json(refreshResponse)).toMatchObject({ profileId: 'claude', engineId: 'claude' });
  });

  it('applies a config change live to an online profile and persists it', async () => {
    const view = await json(
      await post('/api/config', handle.token, { mode: 'team', maxConcurrentRuns: 7, requireMentionInGroup: false }),
    );
    expect(view.mode).toBe('team');
    expect(view.live).toBe(true);
    expect(online.get('claude').profileConfig.mode).toBe('team'); // in-memory controls updated

    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.profiles.claude.mode).toBe('team');
  });

  it('reconnects only when online meeting enablement changes', async () => {
    const controls = online.get('claude');
    const enabled = await json(
      await post('/api/config', handle.token, {
        meeting: { enabled: true, trigger: '@aria' },
      }),
    );
    expect(enabled.meeting).toMatchObject({ enabled: true, trigger: '@aria' });
    expect(controls.restart).toHaveBeenCalledWith({ wait: true });

    controls.restart.mockClear();
    const tuned = await json(
      await post('/api/config', handle.token, { meeting: { trigger: '@assistant' } }),
    );
    expect(tuned.meeting).toMatchObject({ enabled: true, trigger: '@assistant' });
    expect(controls.restart).not.toHaveBeenCalled();
  });

  it('reads and writes an offline profile on disk (deferred, live=false)', async () => {
    const view = await json(await get('/api/config?profile=work', handle.token));
    expect(view.live).toBe(false);

    const saved = await json(
      await post('/api/config?profile=work', handle.token, {
        mode: 'team',
        meeting: { enabled: true },
      }),
    );
    expect(saved.live).toBe(false);
    expect(saved.meeting.enabled).toBe(true);
    const disk = JSON.parse(await readFile(configPath, 'utf8'));
    expect(disk.profiles.work.mode).toBe('team');
    expect(disk.profiles.work.meeting.enabled).toBe(true);
    expect(disk.profiles.claude.mode).toBe('personal');
  });

  it('adds and removes access entries', async () => {
    const added = await json(await post('/api/access', handle.token, { action: 'add', kind: 'user', id: 'ou_alice' }));
    expect(added.allowedUsers).toContain('ou_alice');
    const removed = await json(await post('/api/access', handle.token, { action: 'remove', kind: 'user', id: 'ou_alice' }));
    expect(removed.allowedUsers).not.toContain('ou_alice');
  });

  it('persists offline-profile access through the same deferred command path', async () => {
    const added = await json(
      await post('/api/access?profile=work', handle.token, {
        action: 'add',
        kind: 'admin',
        id: 'ou_work_admin',
      }),
    );
    expect(added.admins).toContain('ou_work_admin');
    expect(online.has('work')).toBe(false);
    const disk = JSON.parse(await readFile(configPath, 'utf8'));
    expect(disk.profiles.work.access.admins).toContain('ou_work_admin');
    expect(disk.profiles.claude.access.admins).not.toContain('ou_work_admin');
  });

  it('sets and clears a per-chat @-mention override, and drops it when the chat is removed', async () => {
    await json(await post('/api/access', handle.token, { action: 'add', kind: 'chat', id: 'oc_grp' }));

    // Set an override (respond to all — no @ needed).
    const set = await json(
      await post('/api/access', handle.token, { action: 'set-mention', kind: 'chat', id: 'oc_grp', requireMention: false }),
    );
    expect(set.chatRequireMention).toEqual({ oc_grp: false });
    expect(online.get('claude').profileConfig.access.chatRequireMention).toEqual({ oc_grp: false });

    // Clear it (follow global) with null.
    const cleared = await json(
      await post('/api/access', handle.token, { action: 'set-mention', kind: 'chat', id: 'oc_grp', requireMention: null }),
    );
    expect(cleared.chatRequireMention).toEqual({});

    // Re-set then remove the chat → override is dropped too.
    await json(await post('/api/access', handle.token, { action: 'set-mention', kind: 'chat', id: 'oc_grp', requireMention: true }));
    const afterRemove = await json(
      await post('/api/access', handle.token, { action: 'remove', kind: 'chat', id: 'oc_grp' }),
    );
    expect(afterRemove.allowedChats).not.toContain('oc_grp');
    expect(afterRemove.chatRequireMention).toEqual({});
  });

  it('lists profiles with online flag from the supervisor', async () => {
    const { profiles } = await json(await get('/api/profiles', handle.token));
    const byName = Object.fromEntries(profiles.map((p: { name: string }) => [p.name, p]));
    expect(byName.claude.running).toBe(true);
    expect(byName.work.running).toBe(false);
  });

  it('lists online channels from the supervisor', async () => {
    const { bots } = await json(await get('/api/bots', handle.token));
    expect(bots.map((b: { profileName: string }) => b.profileName)).toEqual(['claude']);
  });

  it('exposes channel-neutral trigger read, preview and mutation endpoints', async () => {
    const listed = await json(await get('/api/triggers?profile=claude', handle.token));
    expect(listed).toMatchObject({ schema: 'aria.trigger-read.snapshot.v1', definitions: [] });

    const preview = await json(await get('/api/triggers/preview?id=definition-a&count=3', handle.token));
    expect(preview).toMatchObject({ schema: 'aria.trigger-read.preview.v1', definitionId: 'definition-a' });

    const applied = await json(await post('/api/triggers/execute', handle.token, {
      command: 'pause', input: { definitionId: 'definition-a' },
    }));
    expect(applied).toMatchObject({ schema: 'aria.trigger-management.apply.v1', command: 'pause' });
  });

  it('rejects malformed trigger mutation requests at the HTTP adapter', async () => {
    expect((await post('/api/triggers/execute', handle.token, { command: 'delete', input: {} })).status).toBe(400);
    expect((await post('/api/triggers/execute', handle.token, { command: 'pause', input: [] })).status).toBe(400);
    expect((await get('/api/triggers/preview', handle.token)).status).toBe(400);
  });

  it('starts and stops a profile via the supervisor', async () => {
    expect((await post('/api/profiles/start', handle.token, { profile: 'work' })).status).toBe(200);
    expect(online.has('work')).toBe(true);
    expect((await post('/api/profiles/stop', handle.token, { profile: 'claude' })).status).toBe(200);
    expect(online.has('claude')).toBe(false);
  });

  it('activates an offline profile through the root-scoped management command', async () => {
    const response = await post('/api/profiles/activate', handle.token, { profile: 'work' });

    expect(response.status).toBe(200);
    await expect(json(response)).resolves.toEqual({ ok: true, active: 'work' });
    expect((await loadRootConfig(configPath))?.activeProfile).toBe('work');
    await expect(readFile(join(rootDir, 'active-profile'), 'utf8')).resolves.toBe('work\n');
  });

  it('returns 404 when activating an unknown profile', async () => {
    const response = await post('/api/profiles/activate', handle.token, { profile: 'missing' });

    expect(response.status).toBe(404);
    expect(await json(response)).toEqual({ error: 'profile not found: missing' });
  });

  it('returns 404 for an unknown QR registration session', async () => {
    const res = await get('/api/profiles/qr/status?sessionId=nope', handle.token);
    expect(res.status).toBe(404);
  });

  it('serves channel status, plan, confirm, and commit for a v3 profile', async () => {
    const rc = migrateRootConfigToSchemaV3((await loadRootConfig(configPath))!);
    const work = rc.profiles.work!;
    rc.profiles.work = {
      ...work,
      channels: {
        ...work.channels!,
        instances: {
          ...work.channels!.instances,
          'weixin-main': {
            plugin: 'weixin-ilink',
            enabled: false,
            configVersion: 1,
            config: { mode: 'qr' },
            secretRefs: { bearer: { source: 'file' as const, id: 'weixin/bearer' } },
          },
        },
      },
    };
    await saveRootConfig(rc, configPath);

    const status = await json(await get('/api/channels?profile=work', handle.token));
    expect(status).toMatchObject({ schema: 'aria.channel.status.v1', profileId: 'work' });
    expect(
      status.instances.map((item: { instanceId: string }) => item.instanceId).sort(),
    ).toEqual(['lark-primary', 'weixin-main']);
    expect(JSON.stringify(status)).not.toContain('weixin/bearer');

    const plan = await json(await post('/api/channels/plan', handle.token, {
      profile: 'work',
      command: 'channel.instance.enable',
      input: { instanceId: 'weixin-main' },
    }));
    expect(plan.operation.id).toBe('channel.instance.enable');

    const confirmed = await json(await post('/api/channels/plan/confirm', handle.token, { planId: plan.id }));
    expect(confirmed.status).toBe('confirmed');
    const applied = await json(await post('/api/channels/plan/commit', handle.token, { planId: plan.id }));
    expect(applied.planId).toBe(plan.id);

    const stored = (await loadRootConfig(configPath))!;
    expect(stored.profiles.work?.channels?.instances['weixin-main']?.enabled).toBe(true);
  });

  it('rejects unsupported channel commands and missing plan ids', async () => {
    expect((await post('/api/channels/plan', handle.token, {
      command: 'profile.access.update', input: {},
    })).status).toBe(400);
    expect((await get('/api/channels/plan', handle.token)).status).toBe(400);
  });
});
