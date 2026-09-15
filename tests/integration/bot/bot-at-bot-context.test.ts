import { PersonalGroupPeers } from '../../../src/bot/personal-agent-group';
import { normalize, type NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';
import { waitFor } from '../../helpers/wait-for.js';

const sdkMock = vi.hoisted(() => ({
  channel: undefined as FakeLarkChannel | undefined,
  createLarkChannel: vi.fn(() => {
    if (!sdkMock.channel) throw new Error('fake channel not configured');
    return sdkMock.channel;
  }),
}));

vi.mock('@larksuite/channel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@larksuite/channel')>();
  return {
    ...actual,
    createLarkChannel: sdkMock.createLarkChannel,
  };
});

import { startChannel } from '../../../src/bot/channel.js';
import type { MessageAuditEvent, MessageAuditSink } from '../../../src/runtime/message-audit.js';

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  rawClient: {
    request: ReturnType<typeof vi.fn>;
    application: {
      v6: {
        application: {
          get: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      v1: {
        message: {
          get: ReturnType<typeof vi.fn>;
          list: ReturnType<typeof vi.fn>;
        };
        messageReaction: {
          create: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
    };
  };
  on(handlers: MessageHandlerMap): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getChatMode(chatId: string): Promise<'group' | 'topic'>;
  getChatMembers: ReturnType<typeof vi.fn>;
  getChatBots: ReturnType<typeof vi.fn>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<void>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('bot identity in the run context', () => {
  it('enables cached sender-name resolution at the Lark boundary', async () => {
    const h = await createHarness();

    await startTestBridge(h);

    expect(sdkMock.createLarkChannel).toHaveBeenCalledWith(
      expect.objectContaining({ resolveSenderNames: true, cache: expect.objectContaining({ get: expect.any(Function), set: expect.any(Function) }) }),
    );
  });

  it('passes the connected identity with each run', async () => {
    const h = await createHarness();

    await startTestBridge(h);

    await h.channel.handlers.message?.(message({ messageId: 'om_identity', content: 'hello' }));
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions[0]?.identity).toMatchObject({
      providerId: 'lark', subjectId: 'ou_bot', displayName: 'Bridge',
    });
  });
});

it('delivers restored text from a real SDK normalization through intake to the model', async () => {
  const h = await createHarness();
  await startTestBridge(h);
  const event = {
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: { message_id: 'om_real_normalizer', chat_id: 'oc_chat', chat_type: 'group' as const,
      message_type: 'text', content: JSON.stringify({ text: '@_user_1 @_user_2 从 0 开始轮流数。' }),
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_alice' }, name: 'Alice' },
        { key: '@_user_2', id: { open_id: 'ou_bot' }, name: 'Bridge' },
      ],
    },
  };
  const received = await normalize(event, { botIdentity: h.channel.botIdentity, stripBotMentions: true, includeRaw: true });
  expect(received.content).toBe('@Alice 从 0 开始轮流数。');
  await h.channel.handlers.message?.(received);
  await waitFor(() => h.agent.runOptions.length === 1);
  expect(readSection(h.agent.runOptions[0]!.prompt, 'user_input')).toMatchObject({
    text: '@Alice @Bridge 从 0 开始轮流数。',
  });
});

it('keeps a real self mention in the model input and explains the ping', async () => {
  const h = await createHarness();
  await startTestBridge(h);
  const received = await normalize({
    sender: { sender_id: { open_id: 'ou_human' }, sender_type: 'user' },
    message: { message_id: 'om_real_ping', chat_id: 'oc_chat', chat_type: 'group', message_type: 'text',
      content: JSON.stringify({ text: '@_user_1' }),
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Bridge' }],
    },
  }, { botIdentity: h.channel.botIdentity, stripBotMentions: true, includeRaw: true });
  await h.channel.handlers.message?.(received);
  await waitFor(() => h.agent.runOptions.length === 1);
  const input = readSection(h.agent.runOptions[0]?.prompt ?? '', 'user_input') as { text: string };
  expect(input.text).toContain('@Bridge');
  expect(input.text).toContain('请简短回应');
});

describe('sender identity in bridge_context', () => {
  it('audits the normalized receipt before intake policy processing', async () => {
    const h = await createHarness();
    const events: MessageAuditEvent[] = [];
    await startTestBridge(h, { record: async (event) => { events.push(event); } });
    await h.channel.handlers.message?.(message({
      messageId: 'om_audit', senderId: 'ou_bot_sender', content: '@Bridge hi', rawSenderType: 'app',
    }));
    expect(events[0]).toMatchObject({
      eventId: 'inbound:om_audit', direction: 'inbound', conversationKey: 'oc_chat',
      actorSourceId: 'ou_bot_sender', actorKind: 'bot',
    });
  });

  it('marks a bot sender via raw sender_type and injects botOpenId and mentions', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_from_bot',
        senderId: '***REMOVED***',
        senderName: '***REMOVED***',
        content: '@Bridge 部署完成，请验证',
        rawSenderType: 'app',
        mentions: [
          { key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true },
          { key: '@_user_2', openId: 'ou_human', name: '张三', isBot: false },
        ],
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const context = readSection(h.agent.runOptions[0]?.prompt ?? '', 'bridge_context') as {
      senderType?: string;
      botOpenId?: string;
      mentions?: Array<{ openId?: string; name?: string; isBot?: boolean }>;
    };
    expect(context.senderType).toBe('bot');
    expect(context.botOpenId).toBe('ou_bot');
    expect(context.mentions).toEqual([
      { openId: 'ou_bot', name: 'Bridge', isBot: true },
      { openId: 'ou_human', name: '张三', isBot: false },
    ]);
  });

  it('marks a human sender via raw sender_type', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_from_user',
        content: '@Bridge 帮我看个问题',
        rawSenderType: 'user',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const context = readSection(h.agent.runOptions[0]?.prompt ?? '', 'bridge_context') as {
      senderType?: string;
    };
    expect(context.senderType).toBe('user');
  });

  it('omits senderType when the raw event is unavailable', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_no_raw',
        content: '@Bridge 在吗',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const context = readSection(h.agent.runOptions[0]?.prompt ?? '', 'bridge_context') as Record<
      string,
      unknown
    >;
    expect(context).not.toHaveProperty('senderType');
    expect(context.botOpenId).toBe('ou_bot');
  });

  it('turns a mention-only message into an explicit wake-up ping', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_empty_at',
        content: '',
        rawSenderType: 'user',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const userInput = readSection(h.agent.runOptions[0]?.prompt ?? '', 'user_input') as {
      text: string;
    };
    expect(userInput.text).toContain('唤醒');
    expect(userInput.text).toContain('没有正文');
  });

  it('annotates each message with its sender when a batch merges multiple senders', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_batch_user',
        senderId: 'ou_human',
        senderName: '张三',
        content: '@Bridge 这个报错怎么回事',
        rawSenderType: 'user',
      }),
    );
    await h.channel.handlers.message?.(
      message({
        messageId: 'om_batch_bot',
        senderId: '***REMOVED***',
        senderName: '***REMOVED***',
        content: '我刚发布了 v1.2.3',
        rawSenderType: 'app',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const userInput = readSection(h.agent.runOptions[0]?.prompt ?? '', 'user_input') as {
      text: string;
    };
    expect(userInput.text).toContain('[张三 (user)]:');
    expect(userInput.text).toContain('[***REMOVED*** (bot)]:');
    expect(userInput.text).toContain('这个报错怎么回事');
    expect(userInput.text).toContain('我刚发布了 v1.2.3');
  });

  it('keeps single-message batches free of sender annotations', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({
        messageId: 'om_single',
        content: '@Bridge 看下这个',
        rawSenderType: 'user',
      }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    const userInput = readSection(h.agent.runOptions[0]?.prompt ?? '', 'user_input') as {
      text: string;
    };
    expect(userInput.text).not.toContain('[User (user)]:');
    expect(userInput.text).toContain('看下这个');
  });
});

describe('DM-like group mention policy', () => {
  it('accepts an unmentioned message when the group has one human and one bot', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_solo', content: '直接聊就行', mentionedBot: false }),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.channel.getChatMembers).toHaveBeenCalledWith('oc_chat', { force: true });
    expect(h.channel.getChatBots).toHaveBeenCalledWith('oc_chat', { force: true });
  });

  it('keeps requiring a mention when another human is present', async () => {
    const h = await createHarness();
    h.channel.getChatMembers.mockResolvedValue([
      { id: 'ou_user' },
      { id: 'ou_other' },
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_group', content: '群聊闲聊', mentionedBot: false }),
    );

    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('keeps requiring a mention when another bot is present', async () => {
    const h = await createHarness();
    h.channel.getChatBots.mockResolvedValue([
      { id: 'bot_self', isBot: true },
      { id: 'bot_other', isBot: true },
    ]);
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_multi_bot', content: 'bot 群聊', mentionedBot: false }),
    );

    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('fails closed when membership lookup fails', async () => {
    const h = await createHarness();
    h.channel.getChatMembers.mockRejectedValue(new Error('missing scope'));
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_lookup_fail', content: '无法确认成员', mentionedBot: false }),
    );

    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('treats an exclusive human-agent group as addressed even with a strict stored override', async () => {
    const h = await createHarness();
    h.profileConfig.access.chatRequireMention = { oc_chat: true };
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message({ messageId: 'om_explicit_strict', content: '仍然需要 at', mentionedBot: false }),
    );

    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.channel.getChatMembers).toHaveBeenCalledWith('oc_chat', { force: true });
    expect(h.channel.getChatBots).toHaveBeenCalledWith('oc_chat', { force: true });
  });
});

async function createHarness(): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel & { handlers: MessageHandlerMap };
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('bot-at-bot-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: 'claude',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedChats: ['oc_chat'],
      allowedUsers: ['ou_user'],
    },
  });
  const profileConfig = {
    ...baseProfileConfig,
    workspaces: {
      ...baseProfileConfig.workspaces,
      default: workspace,
    },
  };
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const agent = new FakeAgentAdapter({
    events: [{ type: 'done', terminationReason: 'normal' }],
  });
  const channel = createFakeLarkChannel();
  sdkMock.channel = channel;
  const controls = createControls(profileConfig);
  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });
  return {
    tmp,
    channel,
    agent,
    sessions,
    workspaces,
    profileConfig,
    controls,
  };
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}, messageAudit?: MessageAuditSink, personalGroupPeers?: PersonalGroupPeers): Promise<void> {
  const bridge = await startChannel({
    personalGroupPeers,
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
    cotClient: {
      create: vi.fn(async () => { throw new Error('CoT unavailable in offline harness'); }),
      update: vi.fn(async () => {}),
      complete: vi.fn(async () => {}),
    },
    ...(messageAudit ? { messageAudit } : {}),
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(): FakeLarkChannel & { handlers: MessageHandlerMap } {
  const handlers: MessageHandlerMap = {};
  return {
    handlers,
    botIdentity: { openId: 'ou_bot', name: 'Bridge' },
    rawClient: {
      request: vi.fn(async () => ({ data: { items: [] } })),
      application: {
        v6: {
          application: {
            get: vi.fn(async () => ({
              data: { app: { owner: { owner_id: 'ou_owner' } } },
            })),
          },
        },
      },
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({ data: { items: [] } })),
            list: vi.fn(async () => ({ data: { items: [], has_more: false } })),
          },
          messageReaction: {
            create: vi.fn(async () => ({ data: { reaction_id: 'reaction_1' } })),
            delete: vi.fn(async () => ({})),
          },
        },
      },
    },
    on(nextHandlers) {
      Object.assign(handlers, nextHandlers);
    },
    async connect() {},
    async disconnect() {},
    async getChatMode() {
      return 'group';
    },
    getChatMembers: vi.fn(async () => [{ id: 'ou_user' }]),
    getChatBots: vi.fn(async () => [{ id: 'bot_self', isBot: true }]),
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send() {},
    async stream(_chatId, input) {
      if (isMarkdownStreamInput(input)) {
        await input.markdown({ setContent: async () => {} });
      }
    },
  };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'test',
    profileConfig,
    ownerRefreshState: 'unknown' as const,
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: '/tmp/config.json',
    cfg: profileConfig,
    processId: 'proc_test',
  };
}

function message(input: {
  messageId: string;
  content: string;
  senderId?: string;
  senderName?: string;
  rawSenderType?: string;
  mentionedBot?: boolean;
  mentions?: Array<{ key: string; openId?: string; name?: string; isBot?: boolean }>;
}): NormalizedMessage {
  return {
    messageId: input.messageId,
    chatId: 'oc_chat',
    chatType: 'group',
    senderId: input.senderId ?? 'ou_user',
    senderName: input.senderName ?? 'User',
    content: input.content,
    rawContentType: 'text',
    resources: [],
    mentions:
      input.mentions ??
      (input.mentionedBot === false
        ? []
        : [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }]),
    mentionAll: false,
    mentionedBot: input.mentionedBot ?? true,
    createTime: 1760000001000,
    ...(input.rawSenderType
      ? {
          raw: {
            sender: {
              sender_id: { open_id: input.senderId ?? 'ou_user' },
              sender_type: input.rawSenderType,
            },
            message: { message_id: input.messageId },
          },
        }
      : {}),
  } as unknown as NormalizedMessage;
}

function readSection(prompt: string, tag: string): unknown {
  const match = prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
  if (!match) throw new Error(`missing section ${tag}`);
  return JSON.parse(match[1] ?? 'null') as unknown;
}


interface MarkdownStreamInput {
  markdown(ctrl: { setContent(markdown: string): Promise<void> }): Promise<void> | void;
}

function isMarkdownStreamInput(input: unknown): input is MarkdownStreamInput {
  return Boolean(input && typeof input === 'object' && 'markdown' in input);
}


describe('cooperative terminal delivery', () => {
  const mentions = [
    { key: '@_1', openId: 'ou_bot', name: 'Bridge' },
    { key: '@_2', openId: 'ou_alice', name: 'Alice' },
  ];
  it('waits without creating a completion message or leaking the protocol', async () => {
    const h = await createHarness();
    h.agent = new FakeAgentAdapter({ events: [
      { type: 'final_text', content: '<aria_reply>{"action":"wait"}</aria_reply>' },
      { type: 'done', terminationReason: 'normal' },
    ] });
    const send = vi.spyOn(h.channel, 'send');
    await startTestBridge(h);
    await h.channel.handlers.message?.(message({ messageId: 'wait', rawSenderType: 'user', mentions,
      content: '@Bridge @Alice 请等待 Alice 的结果' }));
    await waitFor(() => h.agent.runOptions.length === 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect((readSection(h.agent.runOptions[0]!.prompt, 'bridge_instructions') as string[]).join('')).toContain('"action":"wait"');
    expect(send).not.toHaveBeenCalled();
  });

  it('publishes a handoff with a structured mention through the freshness seam', async () => {
    const h = await createHarness();
    h.agent = new FakeAgentAdapter({ events: [
      { type: 'final_text', content: '<aria_reply>{"action":"handoff","recipient":"ou_alice","text":"0"}</aria_reply>' },
      { type: 'done', terminationReason: 'normal' },
    ] });
    const send = vi.fn(async () => ({ messageId: 'sent-handoff' }));
    h.channel.send = send as never;
    await startTestBridge(h);
    await h.channel.handlers.message?.(message({ messageId: 'handoff', rawSenderType: 'user', mentions,
      content: '@Bridge @Alice 按顺序轮流报数' }));
    await waitFor(() => send.mock.calls.length === 1);
    expect(send).toHaveBeenCalledWith('oc_chat', { text: '0' }, expect.objectContaining({
      mentions: [{ key: '@_aria_next', openId: 'ou_alice' }],
    }));
    expect(h.channel.rawClient.im.v1.message.list).toHaveBeenCalled();
  });

  it('reports a paused collaboration rather than publishing on a failed history check', async () => {
    const h = await createHarness();
    h.agent = new FakeAgentAdapter({ events: [
      { type: 'final_text', content: '<aria_reply>{"action":"handoff","recipient":"ou_alice","text":"0"}</aria_reply>' },
      { type: 'done', terminationReason: 'normal' },
    ] });
    h.channel.rawClient.im.v1.message.list.mockRejectedValue(Object.assign(new Error('permission denied'), {
      response: { data: { code: 230027, msg: 'need scope: im:message.group_msg' } },
    }));
    const send = vi.fn(async () => ({ messageId: 'paused' }));
    h.channel.send = send as never;
    await startTestBridge(h);
    await h.channel.handlers.message?.(message({ messageId: 'blocked', rawSenderType: 'user', mentions, content: '依次报数' }));
    await waitFor(() => send.mock.calls.length > 0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('oc_chat', { text: expect.stringContaining('协作回复已暂缓') }, expect.anything());
  });
});


it.each([false, true])('relays 0 through 8 across three host runtimes (automatic admission: %s)', async (automatic) => {
  const peers = automatic ? new PersonalGroupPeers() : undefined;
  const names = ['CoCo', 'Alice', 'Jack'];
  const ids = ['ou_coco', 'ou_alice', 'ou_jack'];
  const allMentions = ids.map((openId, i) => ({ key: `@_${i}`, openId, name: names[i] }));
  const hosts: Awaited<ReturnType<typeof createHarness>>[] = [];
  const outputs: Array<{ sender: number; text: string }> = [];
  const terminal = (content: string) => [
    { type: 'final_text' as const, content }, { type: 'done' as const, terminationReason: 'normal' as const },
  ];
  for (let i = 0; i < 3; i++) {
    const h = await createHarness();
    h.channel.botIdentity = { openId: ids[i]!, name: names[i]! };
    if (automatic) {
      h.profileConfig.access.allowedChats = [];
      h.profileConfig.access.admins = ['ou_user'];
      h.channel.rawClient.request.mockImplementation(async (input: { url: string }) => ({ data: {
        items: input.url.endsWith('/bots') ? ids.map(bot_id => ({ bot_id }))
          : [{ member_id: 'ou_user', member_id_type: 'open_id' }], has_more: false,
      } }));
    }
    const runs = i === 0 ? [] : [terminal('<aria_reply>{"action":"wait"}</aria_reply>')];
    for (let n = i; n <= 8; n += 3) {
      runs.push(terminal(n === 8 ? '8' : `<aria_reply>${JSON.stringify({ action: 'handoff', recipient: ids[(i + 1) % 3], text: String(n) })}</aria_reply>`));
    }
    h.agent = new FakeAgentAdapter({ events: runs });
    h.channel.send = vi.fn(async (_chat, content, options) => {
      const text = (content as { text?: string }).text;
      if (!text || !/^\d+$/.test(text)) throw new Error('unexpected cooperative output');
      outputs.push({ sender: i, text });
      const mentions = (options as { mentions?: Array<{ openId?: string }> })?.mentions;
      const target = ids.indexOf(mentions?.[0]?.openId ?? '');
      if (target >= 0) {
        await hosts[target]!.channel.handlers.message?.({ ...message({ messageId: `peer-${text}`,
          senderId: ids[i], rawSenderType: 'bot', content: text,
          mentions: [allMentions[target]!] }), createTime: Date.now() });
      }
      return { messageId: `peer-${text}` };
    }) as never;
    hosts.push(h);
    await startTestBridge(h, undefined, peers);
  }
  // Non-leading peers first enter a real wait state before the leader starts.
  for (const i of [1, 2]) {
    await hosts[i]!.channel.handlers.message?.(message({ messageId: 'start', rawSenderType: 'user',
      mentions: allMentions, content: '按 CoCo、Alice、Jack 顺序从 0 数到 8' }));
  }
  await waitFor(() => hosts[1]!.agent.runOptions.length === 1 && hosts[2]!.agent.runOptions.length === 1);
  await hosts[0]!.channel.handlers.message?.(message({ messageId: 'start', rawSenderType: 'user',
    mentions: allMentions, content: '按 CoCo、Alice、Jack 顺序从 0 数到 8' }));
  await waitFor(() => outputs.length === 9, 12_000);
  expect(outputs).toEqual(Array.from({ length: 9 }, (_, n) => ({ sender: n % 3, text: String(n) })));
  for (let i = 0; i < 3; i++) {
    expect(hosts[i]!.agent.runOptions.length).toBe(i === 0 ? 3 : 4);
  }
}, 18_000);


describe('automatic personal group intake', () => {
  async function personalHarness() {
    const h = await createHarness();
    h.profileConfig.access.allowedChats = [];
    h.profileConfig.access.admins = ['ou_user'];
    const roster = { humans: ['ou_user'], bots: ['ou_bot', 'ou_peer'] };
    h.channel.rawClient.request.mockImplementation(async (input: { url: string }) => ({ data: {
      items: input.url.endsWith('/bots') ? roster.bots.map(bot_id => ({ bot_id }))
        : roster.humans.map(member_id => ({ member_id, member_id_type: 'open_id' })),
      has_more: false,
    } }));
    const peers = new PersonalGroupPeers();
    peers.register('feishu', 'ou_peer');
    await startTestBridge(h, undefined, peers);
    return { ...h, roster, peers };
  }

  it('runs a verified mentioned peer without /invite group and preserves its bot identity', async () => {
    const h = await personalHarness();
    await h.channel.handlers.message?.(message({ messageId: 'auto_peer', content: 'please review',
      senderId: 'ou_peer', rawSenderType: 'app' }));
    await waitFor(() => h.agent.runOptions.length === 1);
    expect(h.agent.runOptions[0]?.prompt).toContain('please review');
    expect(h.profileConfig.access.allowedChats).toEqual([]);
  });

  it('keeps explicit addressing and rejects an unknown peer', async () => {
    const h = await personalHarness();
    await h.channel.handlers.message?.(message({ messageId: 'ambient_peer', content: 'chatter',
      senderId: 'ou_peer', rawSenderType: 'app', mentionedBot: false }));
    h.roster.bots.push('ou_unknown');
    await h.channel.handlers.message?.(message({ messageId: 'unknown_peer', content: 'review',
      senderId: 'ou_unknown', rawSenderType: 'app' }));
    await new Promise(resolve => setTimeout(resolve, 750));
    expect(h.agent.runOptions).toHaveLength(0);
  });

  it('withholds the final answer if members change during the final history check', async () => {
    const h = await personalHarness();
    h.agent.setEvents([
      { type: 'final_text', content: 'private result' },
      { type: 'done', terminationReason: 'normal' },
    ]);
    const send = vi.fn(async () => ({ messageId: 'should-not-send' }));
    h.channel.send = send as never;
    h.channel.rawClient.im.v1.message.list.mockImplementation(async () => {
      h.roster.humans.push('ou_new_user');
      return { data: { items: [], has_more: false } };
    });
    await h.channel.handlers.message?.(message({ messageId: 'private_peer', content: 'review',
      senderId: 'ou_peer', rawSenderType: 'app' }));
    await waitFor(() => h.channel.rawClient.im.v1.message.list.mock.calls.length > 0);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(send).not.toHaveBeenCalled();
  });

  it('rechecks the audience after the debounce queue before starting a run', async () => {
    const h = await personalHarness();
    await h.channel.handlers.message?.(message({ messageId: 'queued_peer', content: 'review',
      senderId: 'ou_peer', rawSenderType: 'app' }));
    h.roster.humans.push('ou_new_user');
    await new Promise(resolve => setTimeout(resolve, 750));
    expect(h.agent.runOptions).toHaveLength(0);
  });
});
