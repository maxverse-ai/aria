import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    await expect(host.run({
      scopeId: 'wechat-kf:kf:user-hash',
      actorId: 'user-hash',
      prompt: '分析图片',
      authorized: true,
      source: 'channel:wechat-kf',
      attachments: [{
        kind: 'image',
        path: join(root, 'image.png'),
        hash: 'image-hash',
        size: 8,
        requiredness: 'required',
        decision: 'accepted',
      }],
    })).resolves.toMatchObject({ ok: true, content: '微信最终回复' });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.prompt).toBe('你好');
    expect(seen[1]?.images).toEqual([join(root, 'image.png')]);
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

    await expect(host.run({
      scopeId: 'wechat-kf:kf:user-hash',
      actorId: 'user-hash',
      prompt: '查询设备信息',
      authorized: true,
      source: 'channel:wechat-kf',
      sourceMessageId: 'wechat-message-1',
      attachments: [{
        kind: 'image', path: join(root, 'image.png'), hash: 'image-hash', size: 8,
        requiredness: 'required', decision: 'accepted',
      }],
    })).resolves.toMatchObject({ ok: true, content: '已找到答案' });

    expect(createRuntime).toHaveBeenCalledWith(expect.objectContaining({ profile: 'wechat-kf' }));
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(2);
    expect(observe).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sourceMessageId: 'wechat-message-1', direction: 'inbound',
      conversationKind: 'p2p', actorKind: 'user',
      attachmentSourceIds: ['image-hash'],
    }));
    expect(observe).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sourceMessageId: expect.stringContaining('wechat-message-1:assistant:'),
      direction: 'outbound', conversationKind: 'p2p', actorKind: 'bot',
    }));
    expect(bind).toHaveBeenLastCalledWith(expect.objectContaining({
      sourceSessionId: 'wechat-thread-1',
      conversationKind: 'p2p',
      sourceMessageIds: expect.arrayContaining([
        'wechat-message-1',
        expect.stringContaining('wechat-message-1:assistant:'),
      ]),
    }));
    await host.close();
    expect(runtime.stop).toHaveBeenCalledOnce();
  });

  it('archives the old thread and starts fresh after reset without deleting history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-profile-host-reset-'));
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
        const threadId = `thread-${seen.length}`;
        return {
          runId: options.runId,
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'system' as const, threadId };
              yield { type: 'final_text' as const, content: threadId };
              yield { type: 'done' as const, threadId, terminationReason: 'normal' as const };
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
      appPaths: { profileDir: root, profile: 'wxkf', rootDir: root },
    });
    mocks.createProfileEngineRuntime.mockReturnValue({
      engineId: 'codex',
      execution: agent,
      dispose: vi.fn(async () => undefined),
    });
    const stateDirectory = join(root, 'state');
    const host = await createProfileConversationHost({
      configPath: join(root, 'config.json'),
      profile: 'wxkf',
      stateDirectory,
    });
    const input = {
      scopeId: 'wechat-kf:kf:user-hash',
      actorId: 'wxkf_user-hash',
      authorized: true,
      source: 'channel:wechat-kf' as const,
    };

    await expect(host.runText({ ...input, prompt: 'first' })).resolves.toMatchObject({
      ok: true,
      content: 'thread-1',
    });
    await expect(host.reset(input.scopeId)).resolves.toEqual({
      interrupted: false,
      archivedSessionCount: 1,
    });
    await expect(host.runText({ ...input, prompt: 'second' })).resolves.toMatchObject({
      ok: true,
      content: 'thread-2',
    });

    expect(seen[0]?.threadId).toBeUndefined();
    expect(seen[1]?.threadId).toBeUndefined();
    const catalog = JSON.parse(
      await readFile(join(stateDirectory, 'sessions.catalog.json'), 'utf8'),
    ) as Array<{ status: string; threadId?: string }>;
    expect(catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'archived', threadId: 'thread-1' }),
      expect.objectContaining({ status: 'active', threadId: 'thread-2' }),
    ]));
    await host.close();
  });

  it('prevents a run still preparing during reset from restoring the old generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-profile-host-reset-race-'));
    tempDirectories.push(root);
    const profileConfig = createDefaultProfileConfig({
      agentKind: 'codex',
      mode: 'team',
      accounts: { app: { id: 'app-id', secret: 'unused', tenant: 'feishu' } },
      codex: { binaryPath: 'codex' },
    });
    profileConfig.workspaces.default = root;
    let releasePrepare!: () => void;
    let announcePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    const prepareStarted = new Promise<void>((resolve) => { announcePrepare = resolve; });
    let prepareCount = 0;
    const seen: AgentRunOptions[] = [];
    const stop = vi.fn(async () => undefined);
    const agent: AgentAdapter = {
      id: 'codex',
      displayName: 'Codex',
      isAvailable: async () => true,
      prepareRun: async () => {
        prepareCount += 1;
        if (prepareCount === 1) {
          announcePrepare();
          await prepareGate;
        }
      },
      run: (options) => {
        seen.push(options);
        const threadId = `thread-${seen.length}`;
        return {
          runId: options.runId,
          events: {
            async *[Symbol.asyncIterator]() {
              yield { type: 'system' as const, threadId };
              yield { type: 'final_text' as const, content: threadId };
              yield { type: 'done' as const, threadId, terminationReason: 'normal' as const };
            },
          },
          stop,
          waitForExit: async () => true,
        };
      },
    };
    mocks.resolveProfileRuntime.mockResolvedValue({
      cfg: profileConfig,
      profileConfig,
      configPath: join(root, 'config.json'),
      appPaths: { profileDir: root, profile: 'wxkf', rootDir: root },
    });
    mocks.createProfileEngineRuntime.mockReturnValue({
      engineId: 'codex',
      execution: agent,
      dispose: vi.fn(async () => undefined),
    });
    const host = await createProfileConversationHost({
      configPath: join(root, 'config.json'),
      profile: 'wxkf',
      stateDirectory: join(root, 'state'),
    });
    const input = {
      scopeId: 'wechat-kf:kf:user-hash',
      actorId: 'wxkf_user-hash',
      authorized: true,
      source: 'channel:wechat-kf' as const,
    };

    const oldRun = host.runText({ ...input, prompt: 'old generation' });
    await prepareStarted;
    const reset = host.reset(input.scopeId);
    releasePrepare();

    await expect(oldRun).resolves.toMatchObject({ ok: false, code: 'run-interrupted' });
    await expect(reset).resolves.toMatchObject({ interrupted: true });
    await expect(host.runText({ ...input, prompt: 'new generation' })).resolves.toMatchObject({
      ok: true,
      content: 'thread-2',
    });
    expect(stop).toHaveBeenCalled();
    expect(seen[1]?.threadId).toBeUndefined();
    await host.close();
  });
});
