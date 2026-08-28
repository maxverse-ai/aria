import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRunOptions } from '../../../src/agent/types';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

const mocks = vi.hoisted(() => ({
  resolveProfileRuntime: vi.fn(),
  createProfileEngineRuntime: vi.fn(),
  checkRuntimeAgentAvailability: vi.fn(async () => ({ ok: true as const })),
  loadExternalEnginePlugins: vi.fn(async () => []),
}));

vi.mock('../../../src/runtime/profile-runtime', () => ({
  resolveProfileRuntime: mocks.resolveProfileRuntime,
}));
vi.mock('../../../src/runtime/agent-runtime', () => ({
  createProfileEngineRuntime: mocks.createProfileEngineRuntime,
  checkRuntimeAgentAvailability: mocks.checkRuntimeAgentAvailability,
}));
vi.mock('../../../src/agent/plugin/registry', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/agent/plugin/registry')>();
  return {
    ...original,
    loadExternalEnginePlugins: mocks.loadExternalEnginePlugins,
  };
});

import { createProfileConversationHost } from '../../../src/conversation/profile-host';

const tempDirectories: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('createProfileConversationHost', () => {
  it('runs an authorized text turn and preserves the engine final answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-profile-host-'));
    tempDirectories.push(root);
    const profileConfig = createDefaultProfileConfig({
      agentKind: 'codex',
      mode: 'team',
      accounts: { app: { id: 'app-id', secret: 'unused', tenant: 'feishu' } },
      codex: { binaryPath: 'codex' },
    });
    profileConfig.workspaces.default = root;
    const seen: AgentRunOptions[] = [];
    const agent: AgentAdapter = {
      id: 'codex',
      displayName: 'Codex',
      isAvailable: async () => true,
      run: (options) => {
        seen.push(options);
        return {
          runId: options.runId,
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'system' as const, threadId: 'thread-1' };
              yield { type: 'final_text' as const, content: '微信最终回复' };
              yield { type: 'done' as const, threadId: 'thread-1', terminationReason: 'normal' as const };
            },
          },
          stop: async () => undefined,
          waitForExit: async () => true,
        };
      },
    };
    mocks.resolveProfileRuntime.mockResolvedValue({
      cfg: profileConfig,
      profileConfig,
      configPath: join(root, 'config.json'),
      appPaths: { profileDir: root, profile: 'pm-knowledge-bot', rootDir: root },
    });
    mocks.createProfileEngineRuntime.mockReturnValue({
      engineId: 'codex',
      execution: agent,
      dispose: vi.fn(async () => undefined),
    });

    const host = await createProfileConversationHost({
      configPath: join(root, 'config.json'),
      profile: 'pm-knowledge-bot',
      stateDirectory: join(root, 'wechat-state'),
    });
    await expect(host.runText({
      scopeId: 'wechat-kf:kf:user-hash',
      actorId: 'user-hash',
      prompt: '你好',
      authorized: true,
      source: 'channel:wechat-kf',
    })).resolves.toEqual({ ok: true, runId: expect.any(String), content: '微信最终回复' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.prompt).toBe('你好');
    await host.close();
  });

  it('rejects an unauthorized turn before spawning the engine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-profile-host-deny-'));
    tempDirectories.push(root);
    const profileConfig = createDefaultProfileConfig({
      agentKind: 'codex',
      accounts: { app: { id: 'app-id', secret: 'unused', tenant: 'feishu' } },
      codex: { binaryPath: 'codex' },
    });
    profileConfig.workspaces.default = root;
    const run = vi.fn();
    mocks.resolveProfileRuntime.mockResolvedValue({
      cfg: profileConfig,
      profileConfig,
      configPath: join(root, 'config.json'),
      appPaths: { profileDir: root, profile: 'pm-knowledge-bot', rootDir: root },
    });
    mocks.createProfileEngineRuntime.mockReturnValue({
      engineId: 'codex',
      execution: {
        id: 'codex',
        displayName: 'Codex',
        isAvailable: async () => true,
        run,
      },
      dispose: vi.fn(async () => undefined),
    });

    const host = await createProfileConversationHost({
      configPath: join(root, 'config.json'),
      profile: 'pm-knowledge-bot',
      stateDirectory: join(root, 'wechat-state'),
    });
    const result = await host.runText({
      scopeId: 'wechat-kf:kf:user-hash',
      actorId: 'user-hash',
      prompt: '你好',
      authorized: false,
    });
    expect(result).toMatchObject({ ok: false, code: 'access-denied' });
    expect(run).not.toHaveBeenCalled();
    await host.close();
  });
});
