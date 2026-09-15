import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReadOnlyControlPlane } from '../../../src/application/control';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  createRootConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { startRuntimeControlServer } from '../../../src/runtime/control-server';
import { RuntimeActivityTracker } from '../../../src/runtime/activity';
import type { PresentationState } from '../../../src/outbound/presentation';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ReadOnlyControlPlane', () => {
  it('gets effective presentation from the authenticated running owner, and reports it absent when offline', async () => {
    const fixture = await createFixture();
    const paths = resolveAppPaths({ rootDir: fixture.root, profile: 'team-bot' });
    const presentation: PresentationState = { schema: 'aria.presentation.v1',
      configured: { cotMessages: 'detailed', messageReply: 'markdown', showToolCalls: true },
      effective: { cotMessages: 'off', messageReply: 'markdown', progress: 'none', showToolCalls: false },
      reasons: ['policy-progress-unavailable'] };
    const server = await startRuntimeControlServer({ profile: 'team-bot', endpoint: join(fixture.root, 'control.sock'),
      sidecarFile: paths.runtimeControlFile,
      snapshot: () => ({ ...new RuntimeActivityTracker('team-bot', 'fixture', []).snapshot(), presentation }) });
    const plane = new ReadOnlyControlPlane({ rootDir: fixture.root });
    try { expect((await plane.configSnapshot('team-bot')).presentation.runtime).toEqual(presentation); }
    finally { await server.close(); }
    const offline = await plane.configSnapshot('team-bot');
    expect(offline.presentation.cotMessages).toBe('detailed');
    expect(offline.presentation.runtime).toBeUndefined();
  });
  it('reports versioned discoverable capabilities', () => {
    const plane = new ReadOnlyControlPlane({ rootDir: '/unused' });

    expect(plane.capabilities()).toEqual({
      schema: 'aria.control.capabilities.v1',
      apiVersion: 1,
      capabilities: [
        expect.objectContaining({ id: 'control.capabilities', access: 'read' }),
        expect.objectContaining({ id: 'profile.show', access: 'read' }),
        expect.objectContaining({ id: 'config.show', access: 'read' }),
        expect.objectContaining({ id: 'config.settings', access: 'read' }),
        expect.objectContaining({ id: 'config.plan', access: 'write' }),
        expect.objectContaining({ id: 'config.plan.show', access: 'read' }),
        expect.objectContaining({ id: 'config.plan.confirm', access: 'write' }),
        expect.objectContaining({ id: 'config.plan.apply', access: 'write' }),
        expect.objectContaining({ id: 'trigger.capabilities', access: 'read' }),
        expect.objectContaining({ id: 'trigger.schema', access: 'read' }),
        expect.objectContaining({ id: 'runtime.status', access: 'read' }),
      ],
    });
  });

  it('returns redacted, allowlisted profile and configuration snapshots', async () => {
    const fixture = await createFixture();
    const plane = new ReadOnlyControlPlane({ rootDir: fixture.root });

    const profile = await plane.profileSummary('team-bot');
    const config = await plane.configSnapshot('team-bot');
    const serialized = JSON.stringify({ profile, config });

    expect(profile).toMatchObject({
      schema: 'aria.control.profile.v1',
      profile: { name: 'team-bot', active: true },
      agent: { kind: 'codex' },
      deployment: { mode: 'team' },
      application: { tenant: 'feishu' },
    });
    expect(config).toMatchObject({
      schema: 'aria.control.config.v1',
      revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      agent: { kind: 'codex', model: 'gpt-test', serviceTier: 'fast' },
      access: {
        allowedUsers: 1,
        allowedChats: 1,
        admins: 1,
        requireMentionInGroup: false,
      },
      identity: {
        storedLarkCliPreset: 'user-default',
        effectiveLarkCliPreset: 'bot-only',
      },
      workspace: { defaultConfigured: true },
      presentation: {
        messageReply: 'markdown',
        showToolCalls: true,
        cotMessages: 'detailed',
      },
      execution: {
        maxConcurrentRuns: 4,
        runIdleTimeoutMs: 120_000,
        agentStopGraceMs: 7_000,
      },
    });
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('ou_private');
    expect(serialized).not.toContain('oc_private');
    expect(serialized).not.toContain('/private/workspace');
    expect(serialized).not.toContain('cli_sensitive');
  });

  it('reports runtime state without exposing app ids or config paths', async () => {
    const fixture = await createFixture();
    const plane = new ReadOnlyControlPlane({ rootDir: fixture.root });

    const runtime = await plane.runtimeStatus('team-bot');
    const serialized = JSON.stringify(runtime);

    expect(runtime).toMatchObject({
      schema: 'aria.control.runtime.v1',
      profile: 'team-bot',
      lock: { locked: false, uncertain: false },
      processes: [],
    });
    expect(serialized).not.toContain('cli_sensitive');
    expect(serialized).not.toContain('config.json');
  });
});

async function createFixture(): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'aria-control-plane-'));
  roots.push(root);
  const appPaths = resolveAppPaths({ rootDir: root, profile: 'team-bot' });
  await mkdir(appPaths.profileDir, { recursive: true });
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    mode: 'team',
    accounts: {
      app: {
        id: 'cli_sensitive',
        secret: 'super-secret',
        tenant: 'feishu',
      },
    },
    preferences: {
      model: 'gpt-test',
      serviceTier: 'fast',
      maxConcurrentRuns: 4,
      runIdleTimeoutMinutes: 2,
      agentStopGraceMs: 7_000,
    },
    access: {
      allowedUsers: ['ou_private'],
      allowedChats: ['oc_private'],
      admins: ['ou_admin'],
      requireMentionInGroup: false,
    },
    codex: { binaryPath: 'codex' },
  });
  profile.larkCli.identityPreset = 'user-default';
  profile.workspaces.default = '/private/workspace';
  const rootConfig = createRootConfig('team-bot', profile);
  await saveRootConfig(rootConfig, appPaths.configFile);
  await writeActiveProfile(root, 'team-bot');
  return { root };
}
