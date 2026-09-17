import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../../../src/agent/types';
import { createEngineTurnDelivery } from '../../../src/bot/channel';
import { ChatModeCache } from '../../../src/bot/chat-mode-cache';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { SessionCatalog } from '../../../src/session/catalog';
import type { RunExecution } from '../../../src/runtime/run-executor';
import { createFakeChannel, type FakeChannel } from '../../helpers/fake-channel';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile';

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function harness(options: { events?: AgentEvent[]; threadInScope?: boolean } = {}) {
  const tmp = await createTmpProfile('engine-turn-');
  cleanups.push(() => tmp.cleanup());
  const workspace = await realpath(tmp.workspace);
  const profileConfig = createDefaultProfileConfig({
    agentKind: 'codex',
    codex: { binaryPath: process.execPath },
    accounts: { app: { id: 'cli_test', secret: 'secret', tenant: 'feishu' } },
    preferences: { cotMessages: 'off' },
  });
  const catalog = new SessionCatalog(join(tmp.root, 'sessions.catalog.json'));
  const scope = options.threadInScope ? 'oc_engine_goal:omt_topic' : 'oc_engine_goal';
  catalog.upsertActive({
    scopeId: scope,
    agentId: 'codex',
    cwdRealpath: workspace,
    policyFingerprint: 'fixture',
    threadId: 'thread-1',
  });
  const agent = new FakeAgentAdapter({
    events: options.events ?? [
      { type: 'text', delta: '目标又推进了一步' },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ],
  });
  const adopted = await agent.run({
    runId: 'engine-turn:turn-1',
    scopeId: scope,
    prompt: '',
    cwd: workspace,
    threadId: 'thread-1',
  });
  const execution = {
    runId: adopted.runId,
    scopeId: scope,
    run: adopted,
    handle: { interrupted: false },
    subscribe: () => adopted.events,
    stop: () => adopted.stop(),
  } as unknown as RunExecution;
  const channel = createFakeChannel();
  const adoptEngineTurn = vi.fn(async () => adopted);
  const delivery = createEngineTurnDelivery({
    channel: channel as unknown as Parameters<typeof createEngineTurnDelivery>[0]['channel'],
    controls: {
      profile: 'test',
      profileConfig,
      cfg: profileConfig,
      botOwnerId: 'ou_owner',
      ownerRefreshState: 'unknown',
      async refreshOwner() {},
      async restart() {},
      async exit() {},
      configPath: '/tmp/config.json',
      processId: 'proc_test',
      adoptEngineTurn,
    } as unknown as Parameters<typeof createEngineTurnDelivery>[0]['controls'],
    conversations: {
      ingress: { run: (operation: () => Promise<unknown>) => operation() },
      idleTimeoutMinutes: () => undefined,
      finalizeTurn: async (_scope: string, runId: string, operation: (context: unknown) => Promise<unknown>) =>
        operation({ scopeId: scope, runId, initialWatermarkMs: 0, knownInputIds: new Set<string>() }),
    } as unknown as Parameters<typeof createEngineTurnDelivery>[0]['conversations'],
    executor: { adopt: async () => execution } as unknown as Parameters<typeof createEngineTurnDelivery>[0]['executor'],
    sessionCatalog: catalog,
    finalReplyFreshness: {
      inspect: async () => ({ kind: 'fresh' }),
      inspectLocal: async () => ({ kind: 'fresh' }),
    } as unknown as Parameters<typeof createEngineTurnDelivery>[0]['finalReplyFreshness'],
    chatModeCache: new ChatModeCache(),
  });
  return { delivery, channel, adoptEngineTurn, scope, profileConfig };
}

function sentMarkdown(channel: FakeChannel): string {
  return channel.sent
    .map((entry) => (entry.content as { markdown?: string })?.markdown ?? '')
    .join('\n');
}

describe('engine turn delivery', () => {
  it('publishes the final answer of a turn the engine started', async () => {
    const h = await harness();

    await h.delivery({ threadId: 'thread-1', turnId: 'turn-1' });

    expect(h.adoptEngineTurn).toHaveBeenCalledWith({
      threadId: 'thread-1',
      turnId: 'turn-1',
      cwd: expect.any(String),
    });
    expect(sentMarkdown(h.channel)).toContain('目标又推进了一步');
  });

  it('answers inside the topic when the session scope is a topic', async () => {
    const h = await harness({ threadInScope: true, events: [
      { type: 'text', delta: '话题里的进展' },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ] });

    await h.delivery({ threadId: 'thread-1', turnId: 'turn-1' });

    const message = h.channel.sent.at(-1);
    expect(message?.chatId).toBe(h.scope.split(':')[0]);
    expect(message?.options).toMatchObject({ replyInThread: true });
  });

  it('ignores a thread no active session claims', async () => {
    const h = await harness();

    await h.delivery({ threadId: 'thread-unknown', turnId: 'turn-1' });

    expect(h.adoptEngineTurn).not.toHaveBeenCalled();
    expect(h.channel.sent).toHaveLength(0);
  });

  it('says nothing when the turn produced no final answer', async () => {
    const h = await harness({ events: [{ type: 'done', threadId: 'thread-1', terminationReason: 'normal' }] });

    await h.delivery({ threadId: 'thread-1', turnId: 'turn-1' });

    expect(h.channel.sent).toHaveLength(0);
  });
});
