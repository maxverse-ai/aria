import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, AgentRunOptions } from '../../../src/agent/types';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import type { NativeReadProfileRuntime } from '../../../src/runtime/native-read-runtime';

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

  it('publishes external-channel runs and messages through an independent native-read profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-profile-host-native-read-'));
    tempDirectories.push(root);
    const profileConfig = createDefaultProfileConfig({
      agentKind: 'codex',
      mode: 'team',
      accounts: { app: { id: 'app-id', secret: 'unused', tenant: 'feishu' } },
      codex: { binaryPath: 'codex' },
    });
    profileConfig.workspaces.default = root;
    const agent: AgentAdapter = {
      id: 'codex',
      displayName: 'Codex',
      isAvailable: async () => true,
      run: (options) => ({
        runId: options.runId,
        events: {
          async *[Symbol.asyncIterator]() {
            yield { type: 'system' as const, threadId: 'wechat-thread-1' };
            yield { type: 'final_text' as const, content: '已找到答案' };
            yield { type: 'done' as const, threadId: 'wechat-thread-1', terminationReason: 'normal' as const };
          },
        },
        stop: async () => undefined,
        waitForExit: async () => true,
      }),
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

    const observe = vi.fn(async () => undefined);
    const bind = vi.fn(async () => undefined);
    const runtime = {
      audit: {},
      runAudit: { record: vi.fn(async () => undefined) },
      messageAudit: { record: vi.fn(async () => undefined) },
      messageRead: { observe, bind, remove: vi.fn(async () => undefined) },
      governanceAudit: { record: vi.fn(async () => undefined) },
      start: vi.fn(async () => undefined),
      refreshSessions: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    } as unknown as NativeReadProfileRuntime;
    const createRuntime = vi.fn(async () => runtime);
    const host = await createProfileConversationHost({
      configPath: join(root, 'config.json'),
      profile: 'pm-knowledge-bot',
      stateDirectory: join(root, 'wechat-state'),
      nativeRead: {
        profile: 'wechat-kf',
        rootDirectory: join(root, 'channel'),
        createRuntime,
      },
    });

    await expect(host.runText({
      scopeId: 'wechat-kf:kf:user-hash',
      actorId: 'user-hash',
      prompt: '查询设备信息',
      authorized: true,
      source: 'channel:wechat-kf',
      sourceMessageId: 'wechat-message-1',
    })).resolves.toMatchObject({ ok: true, content: '已找到答案' });

    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ profile: 'wechat-kf' }));
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sourceMessageId: 'wechat-message-1', direction: 'inbound',
    }));
    expect(observe).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sourceMessageId: expect.stringContaining('wechat-message-1:assistant:'),
      direction: 'outbound',
    }));
    expect(bind).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceSessionId: 'wechat-thread-1',
      sourceMessageIds: expect.arrayContaining([
        'wechat-message-1',
        expect.stringContaining('wechat-message-1:assistant:'),
      ]),
    }));
    await host.close();
    expect(runtime.stop).toHaveBeenCalledOnce();
  });
});
