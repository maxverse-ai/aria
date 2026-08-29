import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CardActionEvent, NormalizedMessage } from '@larksuite/channel';
import { claudeCapability, codexCapability } from '../../../src/agent/capability.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import type { ChatModeCache } from '../../../src/bot/chat-mode-cache.js';
import { PendingQueue } from '../../../src/bot/pending-queue.js';
import { handleCardAction } from '../../../src/card/dispatcher.js';
import {
  tryHandleCommand,
  type AgentSwitchResult,
  type CommandContext,
  type Controls,
} from '../../../src/commands/index.js';
import { createDefaultProfileConfig, type AgentKind, type ProfileConfig } from '../../../src/config/profile-schema.js';
import { createRootConfig, saveRootConfig } from '../../../src/config/profile-store.js';
import { canUseDm } from '../../../src/policy/access.js';
import { evaluateRunPolicy } from '../../../src/policy/run-policy.js';
import { resolveWorkingDirectory } from '../../../src/policy/workspace.js';
import { SessionCatalog, type SessionCatalogIdentity } from '../../../src/session/catalog.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import type { CodexThreadHistoryEntry } from '../../../src/session/codex-history.js';
import type { SessionSummary } from '../../../src/session/history.js';
import { createFakeAgent } from '../../helpers/fake-agent.js';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel.js';
import { writeVersionExecutable } from '../../helpers/fake-executable.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

interface Harness {
  tmp: TmpProfile;
  channel: FakeChannel;
  controlChannel: FakeChannel;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  catalog: SessionCatalog;
  controls: Controls;
  identity: SessionCatalogIdentity;
  claudeHistory: SessionSummary[];
  codexHistory: CodexThreadHistoryEntry[];
  activeRuns: ActiveRuns;
  pending: PendingQueue;
  run(content: string, options?: { withCatalogIdentity?: boolean; chatMode?: 'p2p' | 'group' | 'topic' }): Promise<boolean>;
  dispatchResumeArg(arg: string): Promise<void>;
  dispatchCard(value: Record<string, unknown>, messageId?: string): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

describe('agent-aware resume commands', () => {
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('archives only the current catalog entry when starting a new conversation', async () => {
    const h = await createHarness('claude');
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    h.catalog.upsertActive({
      ...h.identity,
      agentId: 'codex',
      threadId: 'thread-other-agent',
      now: 1000,
    });

    await expect(h.run('/new')).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toBeUndefined();
    expect(h.catalog.activeFor({ ...h.identity, agentId: 'codex' })).toMatchObject({
      threadId: 'thread-other-agent',
    });
  });

  it('allows resume use only for the current agent/cwd/policy catalog entry', async () => {
    const h = await createHarness('claude');
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    h.catalog.upsertActive({
      ...h.identity,
      policyFingerprint: 'stale-fp',
      sessionId: 'sess-stale',
      now: 1000,
    });

    await expect(h.run('/resume use sess-stale')).resolves.toBe(true);
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('不可恢复');

    await expect(h.run('/resume use sess-current')).resolves.toBe(true);
    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('sess-current');
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('resumes the selected Claude history entry from the card button callback', async () => {
    const h = await createHarness('claude');
    h.sessions.set('chat-1', 'sess-current', h.identity.cwdRealpath);
    h.catalog.upsertActive({ ...h.identity, sessionId: 'sess-current', now: 1000 });
    h.claudeHistory.push(
      claudeSession('sess-current', 'current prompt', 1_700_000_100_000),
      claudeSession('sess-target', 'target prompt', 1_700_000_000_000),
    );

    await expect(h.run('/resume')).resolves.toBe(true);

    const card = lastContent(h.channel);
    const rendered = JSON.stringify(card);
    expect(rendered).toContain('current prompt');
    expect(rendered).toContain('target prompt');
    expect(rendered).toContain('sess-tar');

    const nonces = resumeArgsFromCard(card);
    expect(nonces).toHaveLength(2);
    expect(nonces[1]).not.toBe('sess-target');
    await h.dispatchResumeArg(nonces[1]!);

    expect(h.sessions.resumeFor('chat-1', h.identity.cwdRealpath)).toBe('sess-target');
    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      sessionId: 'sess-target',
    });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('accepts the current Codex thread without writing it into legacy SessionStore', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/resume')).resolves.toBe(true);
    const nonce = resumeNonce(lastMarkdown(h.channel));

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('falls back to an audit-safe reply when resume confirmation is rejected', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });
    await expect(h.run('/resume')).resolves.toBe(true);
    const nonce = resumeNonce(lastMarkdown(h.channel));
    const originalSend = h.channel.send.bind(h.channel);
    let attempts = 0;
    h.channel.send = async (...args) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('The messages do NOT pass the audit.') as Error & { code: number };
        err.code = 230028;
        throw err;
      }
      return originalSend(...args);
    };

    await expect(h.run(`/resume use ${nonce}`)).resolves.toBe(true);

    expect(attempts).toBe(2);
    expect(lastMarkdown(h.channel)).toBe('命令已处理。');
  });

  it('shows only the current catalog-backed Codex thread in /resume', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('当前 Codex CLI 会话可恢复');
    expect(lastMarkdown(h.channel)).toMatch(/\/resume use [a-f0-9-]+/);
    expect(lastMarkdown(h.channel)).not.toContain('thread-current');
  });

  it('does not accept raw Codex thread ids as resume candidates', async () => {
    const h = await createHarness('codex');
    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });

    await expect(h.run('/resume use thread-current')).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('请先用 `/resume`');
  });

  it('does not fall back to legacy SessionStore when Codex catalog identity is missing', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/resume use thread-current', { withCatalogIdentity: false })).resolves.toBe(true);

    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('当前上下文没有可恢复的引擎会话');
  });

  it('lists engine status through /agent', async () => {
    const h = await createHarness('claude');

    await expect(h.run('/agent')).resolves.toBe(true);

    const rendered = JSON.stringify(lastContent(h.channel));
    expect(rendered).toContain('当前引擎：`claude`');
    expect(rendered).toContain('Claude Code');
    expect(rendered).toContain('Codex CLI');
    expect(rendered).toContain('OpenCode');
  });

  it('updates the original CardKit card from loading to success when switching engines', async () => {
    const h = await createHarness('claude');
    const fakeBin = await writeVersionExecutable(h.tmp.root, 'fake-opencode', '1.18.21');
    const saved = process.env.LARK_CHANNEL_OPENCODE_BIN;
    process.env.LARK_CHANNEL_OPENCODE_BIN = fakeBin;
    try {
      let resolveSwitch!: (result: AgentSwitchResult) => void;
      const pendingSwitch = new Promise<AgentSwitchResult>((resolve) => {
        resolveSwitch = resolve;
      });
      let loadingUpdatesAtSwitch = 0;
      vi.mocked(h.controls.switchAgent!).mockImplementationOnce(() => {
        loadingUpdatesAtSwitch = h.channel.rawClient.requests.filter(
          (request) => request.method === 'cardkit.v1.card.update',
        ).length;
        return pendingSwitch;
      });

      await expect(h.run('/agent')).resolves.toBe(true);
      await expect(
        h.dispatchCard({ cmd: 'agent.use', arg: 'opencode' }, 'om_fake_1'),
      ).resolves.toBeUndefined();

      await vi.waitFor(() => expect(h.controls.switchAgent).toHaveBeenCalledWith(
        'opencode',
        { source: 'card', principal: 'ou-user' },
      ));
      expect(loadingUpdatesAtSwitch).toBe(1);
      let updates = h.channel.rawClient.requests.filter(
        (request) => request.method === 'cardkit.v1.card.update',
      );
      expect(updates).toHaveLength(1);
      expect(JSON.stringify(updates[0])).toContain('正在切换');
      expect(JSON.stringify(updates[0])).not.toContain('已切换到');

      h.controls.profileConfig.agentKind = 'opencode';
      resolveSwitch({
        changed: true,
        previousAgentKind: 'claude',
        currentAgentKind: 'opencode',
        displayName: 'OpenCode',
      });
      await vi.waitFor(() => {
        updates = h.channel.rawClient.requests.filter(
          (request) => request.method === 'cardkit.v1.card.update',
        );
        expect(updates).toHaveLength(2);
      });
      expect(JSON.stringify(updates[1])).toContain('已切换到');
      expect(JSON.stringify(updates[1])).toContain('"schema":"2.0"');
    } finally {
      if (saved === undefined) delete process.env.LARK_CHANNEL_OPENCODE_BIN;
      else process.env.LARK_CHANNEL_OPENCODE_BIN = saved;
    }
  });

  it('sets reasoning effort and lists models through /effort and /models', async () => {
    const h = await createHarness('codex');
    h.controls.engineModels = async () => [
      {
        value: 'gpt-runtime',
        label: 'GPT Runtime',
        isDefault: true,
        reasoning: {
          defaultValue: 'medium',
          options: [
            { value: 'low', label: 'low' },
            { value: 'medium', label: 'medium' },
            { value: 'high', label: 'high' },
            { value: 'xhigh', label: 'xhigh' },
          ],
        },
      },
    ];
    h.controls.engineGeneration = () => 9876;

    await expect(h.run('/effort high')).resolves.toBe(true);
    expect(h.controls.profileConfig.preferences.reasoningEffort).toBe('high');
    expect(lastMarkdown(h.channel)).toContain('已为当前 Agent/模型设置推理配置：`high`');

    await expect(h.run('/effort')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).toContain('当前推理配置：`high`');
    expect(JSON.stringify(lastContent(h.channel))).toContain('xhigh');

    await expect(h.run('/models')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).toContain('gpt-runtime');
  });

  it('controls Codex Fast from Feishu and persists it through the management boundary', async () => {
    const h = await createHarness('codex');
    h.controls.engineModels = async () => [{
      value: 'gpt-fast-test',
      label: 'GPT Fast Test',
      isDefault: true,
      serviceTiers: {
        options: [{ value: 'fast', label: 'Fast', description: 'Lower latency' }],
      },
    }];
    h.controls.engineGeneration = () => 9911;

    await expect(h.run('/fast status')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).toContain('Fast 模式');
    expect(JSON.stringify(lastContent(h.channel))).toContain('开启 Fast');

    await expect(h.run('/fast on')).resolves.toBe(true);
    expect(h.controls.profileConfig.preferences.serviceTier).toBe('fast');
    expect(lastMarkdown(h.channel)).toContain('Fast on');

    await expect(
      h.dispatchCard({ cmd: 'fast.set', arg: 'off' }, 'om_fake_1'),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(h.controls.profileConfig.preferences.serviceTier).toBeNull();
      expect(h.channel.rawClient.requests.filter(
        (request) => request.method === 'cardkit.v1.card.update',
      )).toHaveLength(2);
    });
    const updates = h.channel.rawClient.requests.filter(
      (request) => request.method === 'cardkit.v1.card.update',
    );
    expect(JSON.stringify(updates[0])).toContain('正在更新 Fast 配置');
    expect(JSON.stringify(updates[1])).toContain('Fast off');
  });

  it('keeps /fast unavailable for agents that do not declare service tiers', async () => {
    const h = await createHarness('claude');

    await expect(h.run('/fast on')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('当前 Agent 没有可切换的服务档位');
    expect(h.controls.profileConfig.preferences.serviceTier).toBeUndefined();
  });

  it('controls steering from Feishu and shows capability in status', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/steer status')).resolves.toBe(true);
    expect(JSON.stringify(lastContent(h.channel))).toContain('Steering');
    expect(JSON.stringify(lastContent(h.channel))).toContain('`direct`');

    await expect(h.run('/steer auto')).resolves.toBe(true);
    expect(h.controls.profileConfig.coordination.steering).toBe('auto');
    expect(lastMarkdown(h.channel)).toContain('立即生效');

    await expect(
      h.dispatchCard({ cmd: 'steer.set', arg: 'on' }, 'om_fake_1'),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(h.controls.profileConfig.coordination.steering).toBe('on');
      expect(h.channel.rawClient.requests.filter(
        (request) => request.method === 'cardkit.v1.card.update',
      )).toHaveLength(2);
    });
    const updates = h.channel.rawClient.requests.filter(
      (request) => request.method === 'cardkit.v1.card.update',
    );
    expect(JSON.stringify(updates[0])).toContain('正在更新运行中转向策略');
    expect(JSON.stringify(updates[1])).toContain('策略已更新并立即生效');

    await expect(h.run('/status')).resolves.toBe(true);
    const status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('**steering**');
    expect(status).toContain('on · direct');
  });

  it('keeps the steering control visible with a safe fallback on unsupported agents', async () => {
    const h = await createHarness('claude');

    await expect(h.run('/steer status')).resolves.toBe(true);
    const card = JSON.stringify(lastContent(h.channel));
    expect(card).toContain('`unsupported`');
    expect(card).toContain('消息会安全进入下一轮');
  });

  it('routes Aria-owned model and effort cards through the inspected control channel', async () => {
    const h = await createHarness('codex', { useControlChannel: true });
    h.controls.engineModels = async () => [{
      value: 'gpt-control-test',
      label: 'GPT Control Test',
      isDefault: true,
      reasoning: {
        defaultValue: 'medium',
        options: [
          { value: 'medium', label: 'medium' },
          { value: 'high', label: 'high' },
        ],
      },
    }];

    await expect(h.run('/models')).resolves.toBe(true);
    expect(h.channel.sent).toHaveLength(0);
    expect(JSON.stringify(lastContent(h.controlChannel))).toContain('gpt-control-test');

    await expect(h.run('/effort')).resolves.toBe(true);
    expect(h.channel.sent).toHaveLength(0);
    expect(JSON.stringify(lastContent(h.controlChannel))).toContain('当前推理配置');

    await expect(
      h.dispatchCard({ cmd: 'effort.set', arg: 'high' }, 'om_fake_2'),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(h.controlChannel.rawClient.requests.filter(
        (request) => request.method === 'cardkit.v1.card.update',
      )).toHaveLength(2);
    });
    expect(h.channel.rawClient.requests).toHaveLength(0);
    expect(h.controls.profileConfig.preferences.reasoningEffortByModel).toEqual({
      'codex:gpt-control-test': 'high',
    });
  });

  it('updates one effort card in place using runtime model capabilities', async () => {
    const h = await createHarness('codex');
    h.controls.engineModels = async () => [{
      value: 'gpt-effort-test',
      label: 'GPT Effort Test',
      isDefault: true,
      reasoning: {
        defaultValue: 'medium',
        options: [
          { value: 'medium', label: 'medium' },
          { value: 'xhigh', label: 'xhigh' },
          { value: 'ultra', label: 'ultra', semantics: 'multi-agent' },
        ],
      },
    }];
    h.controls.engineGeneration = () => 9877;

    await expect(h.run('/effort')).resolves.toBe(true);
    expect(h.channel.sent).toHaveLength(1);
    expect(JSON.stringify(lastContent(h.channel))).toContain('ultra（多 Agent）');

    await expect(
      h.dispatchCard({ cmd: 'effort.set', arg: 'xhigh' }, 'om_fake_1'),
    ).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(h.channel.rawClient.requests.filter(
        (request) => request.method === 'cardkit.v1.card.update',
      )).toHaveLength(2);
    });

    const updates = h.channel.rawClient.requests.filter(
      (request) => request.method === 'cardkit.v1.card.update',
    );
    expect(JSON.stringify(updates[0])).toContain('正在切换到');
    expect(JSON.stringify(updates[1])).toContain('已切换到');
    expect(JSON.stringify(updates[1])).toContain('xhigh');
    expect(h.channel.sent).toHaveLength(1);
    expect(h.controls.profileConfig.preferences.reasoningEffortByModel).toEqual({
      'codex:gpt-effort-test': 'xhigh',
    });
  });

  it('updates one models card from loading to switch success without sending another card', async () => {
    const h = await createHarness('claude');

    await expect(h.run('/models')).resolves.toBe(true);
    expect(h.channel.sent).toHaveLength(1);

    await expect(
      h.dispatchCard({ cmd: 'models.use', arg: 'claude-sonnet-4-6' }, 'om_fake_1'),
    ).resolves.toBeUndefined();

    await vi.waitFor(() => {
      expect(
        h.channel.rawClient.requests.filter(
          (request) => request.method === 'cardkit.v1.card.update',
        ),
      ).toHaveLength(2);
    });
    const updates = h.channel.rawClient.requests.filter(
      (request) => request.method === 'cardkit.v1.card.update',
    );
    expect(updates).toHaveLength(2);
    expect(JSON.stringify(updates[0])).toContain('正在切换到模型');
    expect(JSON.stringify(updates[1])).toContain('已切换到模型');
    expect(JSON.stringify(updates[1])).toContain('claude-sonnet-4-6');
    expect(h.channel.sent).toHaveLength(1);
    expect(h.controls.profileConfig.preferences.model).toBe('claude-sonnet-4-6');
  });

  it('does not list Claude local history for Codex when no current thread is recorded', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastContentString(h.channel)).toContain('此 cwd 下没有历史会话');
  });

  it('lists Codex history for the current cwd and resumes the selected thread through a nonce', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(
      codexThread('thread-alpha-secret', 'alpha prompt', 1_700_000_100_000),
      codexThread('thread-beta-secret', 'beta prompt', 1_700_000_000_000),
    );

    await expect(h.run('/resume')).resolves.toBe(true);

    const card = lastContent(h.channel);
    const rendered = JSON.stringify(card);
    expect(rendered).toContain('alpha prompt');
    expect(rendered).toContain('beta prompt');
    expect(rendered).not.toContain('thread-alpha-secret');
    expect(rendered).not.toContain('thread-beta-secret');

    const nonces = resumeArgsFromCard(card);
    expect(nonces).toHaveLength(2);
    await expect(h.run(`/resume use ${nonces[1]}`)).resolves.toBe(true);

    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      threadId: 'thread-beta-secret',
    });
    expect(h.sessions.getRaw('chat-1')).toBeUndefined();
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('resumes a Codex history selection from the card button callback', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-alpha-secret', 'alpha prompt', 1_700_000_100_000));

    await expect(h.run('/resume')).resolves.toBe(true);

    const [nonce] = resumeArgsFromCard(lastContent(h.channel));
    expect(nonce).toBeTypeOf('string');
    await h.dispatchResumeArg(nonce!);

    expect(h.catalog.activeFor(h.identity)).toMatchObject({
      threadId: 'thread-alpha-secret',
    });
    expect(lastMarkdown(h.channel)).toContain('已完成');
  });

  it('keeps Codex resume history details out of group chats like Claude', async () => {
    const h = await createHarness('codex');
    h.codexHistory.push(codexThread('thread-alpha-secret', 'alpha prompt', 1_700_000_100_000));

    await expect(h.run('/resume', { chatMode: 'group' })).resolves.toBe(true);

    const rendered = lastContentString(h.channel);
    expect(rendered).toContain('私聊');
    expect(rendered).not.toContain('alpha prompt');
    expect(rendered).not.toContain('thread-alpha-secret');
  });

  it('labels Codex status as session while reading the recorded thread id', async () => {
    const h = await createHarness('codex');

    await expect(h.run('/status')).resolves.toBe(true);
    let status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('**session**');
    expect(status).toContain('未建立');
    expect(status).not.toContain('**thread**');
    expect(status).not.toContain('**conversation**');

    h.catalog.upsertActive({ ...h.identity, threadId: 'thread-current', now: 1000 });
    await expect(h.run('/status')).resolves.toBe(true);

    status = JSON.stringify(lastContent(h.channel));
    expect(status).toContain('**session**');
    expect(status).toContain('thread-c');
    expect(status).not.toContain('未建立');
  });

  it('does not list local history from home when no workspace is bound', async () => {
    const h = await createHarness('claude', { bindWorkspace: false, defaultWorkspace: false });

    await expect(h.run('/resume')).resolves.toBe(true);

    expect(lastMarkdown(h.channel)).toContain('请先使用 /cd');
  });
});

async function createHarness(
  agentKind: AgentKind,
  options: {
    bindWorkspace?: boolean;
    defaultWorkspace?: boolean;
    useControlChannel?: boolean;
  } = {},
): Promise<Harness> {
  const tmp = await createTmpProfile(`resume-command-${agentKind}-`);
  const channel = createFakeChannel();
  const controlChannel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const catalog = new SessionCatalog(join(tmp.profile, 'session-catalog.json'));
  const claudeHistory: SessionSummary[] = [];
  const codexHistory: CodexThreadHistoryEntry[] = [];
  const activeRuns = new ActiveRuns();
  const pending = new PendingQueue(60_000, () => {});
  const agent = createFakeAgent();
  const profileConfig = appConfig(agentKind);
  if (options.defaultWorkspace !== false) {
    profileConfig.workspaces.default = tmp.workspace;
  }
  const configPath = join(tmp.profile, 'config.json');
  await saveRootConfig(createRootConfig(agentKind, profileConfig), configPath);
  const controls = {
    profile: agentKind,
    profileConfig,
    botOwnerId: 'ou-user',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    restart: vi.fn(async () => {}),
    switchAgent: vi.fn(async (targetAgentKind: string) => {
      const previousAgentKind = profileConfig.agentKind;
      profileConfig.agentKind = targetAgentKind;
      return {
        changed: previousAgentKind !== targetAgentKind,
        previousAgentKind,
        currentAgentKind: targetAgentKind,
        displayName: targetAgentKind,
      };
    }),
    exit: vi.fn(async () => {}),
    configPath,
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  if (options.bindWorkspace !== false) {
    workspaces.setCwd('chat-1', tmp.workspace);
  }
  const identity = await commandIdentity(agentKind, profileConfig, controls, tmp.workspace);
  const chatModeCache = {
    resolve: async () => 'p2p',
  } as unknown as ChatModeCache;

  const run = (
    content: string,
    runOptions: { withCatalogIdentity?: boolean; chatMode?: 'p2p' | 'group' | 'topic' } = {},
  ): Promise<boolean> =>
    tryHandleCommand({
      channel: channel as unknown as CommandContext['channel'],
      msg: message(content),
      scope: 'chat-1',
      chatMode: runOptions.chatMode ?? 'p2p',
      sessions,
      sessionCatalog: catalog,
      sessionCatalogIdentity: runOptions.withCatalogIdentity === false ? undefined : identity,
      workspaces,
      agent,
      activeRuns,
      controls,
      ...(options.useControlChannel
        ? { outboundControlChannel: controlChannel as unknown as CommandContext['channel'] }
        : {}),
      claudeHistoryProvider: async () => claudeHistory,
      codexHistoryProvider: async () => codexHistory,
    });

  const dispatchCard = (
    value: Record<string, unknown>,
    messageId = 'om-card',
  ): Promise<void> =>
    handleCardAction({
      channel: channel as unknown as Parameters<typeof handleCardAction>[0]['channel'],
      evt: cardEvent(value, messageId),
      sessions,
      sessionCatalog: catalog,
      workspaces,
      activeRuns,
      agent,
      controls,
      pending,
      chatModeCache,
      ...(options.useControlChannel
        ? { outboundControlChannel: controlChannel as unknown as CommandContext['channel'] }
        : {}),
    });
  const dispatchResumeArg = (arg: string): Promise<void> =>
    dispatchCard({ cmd: 'resume.use', arg });

  cleanups.push(async () => {
    pending.cancelAll();
    await Promise.all([sessions.flush(), workspaces.flush(), catalog.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    controlChannel,
    sessions,
    workspaces,
    catalog,
    controls,
    identity,
    claudeHistory,
    codexHistory,
    activeRuns,
    pending,
    run,
    dispatchResumeArg,
    dispatchCard,
  };
}

function claudeSession(
  sessionId: string,
  preview: string,
  mtime: number,
): SessionSummary {
  return {
    sessionId,
    preview,
    mtime,
    lineCount: 1,
  };
}

async function commandIdentity(
  agentKind: AgentKind,
  profileConfig: ProfileConfig,
  controls: Controls,
  cwd: string,
): Promise<SessionCatalogIdentity> {
  const workspace = await resolveWorkingDirectory(cwd);
  if (!workspace.ok) throw new Error(workspace.userVisible);
  const capability = agentKind === 'codex' ? codexCapability(profileConfig) : claudeCapability(profileConfig);
  const access = canUseDm(profileConfig, controls, 'ou-user');
  const policy = evaluateRunPolicy({
    scope: {
      source: 'im',
      chatId: 'chat-1',
      actorId: 'ou-user',
    },
    attachments: [],
    prompt: '',
    requestedCwd: cwd,
    cwdRealpath: workspace.cwdRealpath,
    access,
    capability,
    profileConfig,
    now: Date.now(),
    codexHome: profileConfig.codex?.codexHome,
    inheritCodexHome: profileConfig.codex?.inheritCodexHome,
  });
  if (!policy.ok) throw new Error(policy.rejectReason.userVisible);
  return {
    scopeId: 'chat-1',
    agentId: capability.agentId,
    cwdRealpath: workspace.cwdRealpath,
    policyFingerprint: policy.policyFingerprint,
  };
}

function appConfig(agentKind: AgentKind): ProfileConfig {
  return createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    access: { admins: ['ou-user'] },
    ...(agentKind === 'codex' ? { codex: { binaryPath: '/usr/local/bin/codex' } } : {}),
  });
}

function message(content: string): NormalizedMessage {
  return {
    messageId: `om-${content.replace(/\W+/g, '-').slice(0, 20)}`,
    chatId: 'chat-1',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}

function cardEvent(value: Record<string, unknown>, messageId = 'om-card'): CardActionEvent {
  return {
    action: { value },
    chatId: 'chat-1',
    messageId,
    operator: {
      openId: 'ou-user',
      name: 'User',
    },
  } as unknown as CardActionEvent;
}

function lastMarkdown(channel: FakeChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: unknown } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown as string;
}

function lastContent(channel: FakeChannel): Record<string, unknown> {
  const content = channel.sent.at(-1)?.content;
  expect(content).toBeTypeOf('object');
  return content as Record<string, unknown>;
}

function lastContentString(channel: FakeChannel): string {
  return JSON.stringify(lastContent(channel));
}

function resumeNonce(markdown: string): string {
  const match = markdown.match(/\/resume use ([a-f0-9-]+)/);
  const nonce = match?.[1];
  expect(nonce).toBeTypeOf('string');
  if (!nonce) throw new Error('missing resume nonce');
  return nonce;
}

function resumeArgsFromCard(card: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const action = record.value as Record<string, unknown> | undefined;
    if (action?.cmd === 'resume.use' && typeof action.arg === 'string') out.push(action.arg);
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(card);
  return out;
}

function codexThread(
  threadId: string,
  preview: string,
  updatedAtMs: number,
): CodexThreadHistoryEntry {
  return {
    threadId,
    sessionId: threadId,
    preview,
    cwd: '/tmp/workspace',
    createdAtMs: updatedAtMs - 1000,
    updatedAtMs,
    source: 'exec',
  };
}
