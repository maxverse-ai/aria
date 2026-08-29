import type { NormalizedMessage } from '@larksuite/channel';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentSteeringRequest } from '../../../src/agent/steering.js';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../../../src/agent/types.js';
import type { FakeAgentEvents, FakeAgentRun } from '../../helpers/fake-agent.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { log } from '../../../src/core/logger.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

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

interface MessageHandlerMap {
  message?: (msg: NormalizedMessage) => Promise<void> | void;
}

interface FakeLarkChannel {
  botIdentity: { openId: string; name: string };
  handlers: MessageHandlerMap;
  sent: Array<{ chatId: string; content: unknown; options?: unknown }>;
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
  getChatMembers(chatId: string, options?: { force?: boolean }): Promise<Array<{ id: string }>>;
  getChatBots(chatId: string, options?: { force?: boolean }): Promise<Array<{ id: string; isBot: true }>>;
  getConnectionStatus(): { state: 'connected'; reconnectAttempts: number };
  send(chatId: string, content: unknown, options?: unknown): Promise<{ messageId: string }>;
  stream(chatId: string, input: unknown, options?: unknown): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}

type StreamFn = FakeLarkChannel['stream'];
type SendFn = FakeLarkChannel['send'];

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  sdkMock.channel = undefined;
  sdkMock.createLarkChannel.mockClear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('automatic active-run follow-ups', () => {
  it('hands an eligible second IM message to the active Codex turn exactly once', async () => {
    const agent = new SteerableFakeAgent();
    const h = await createHarness({
      agent,
      messageReply: 'text',
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'start the task'));
    await waitFor(() => agent.steeringRuns.length === 1);

    await h.channel.handlers.message?.(
      message('om_second', 'continue with this additional constraint'),
    );

    const run = agent.steeringRuns[0];
    if (!run) throw new Error('expected the first run to be active');
    expect(run.steerCalls).toHaveLength(1);
    expect(run.steerCalls[0]).toMatchObject({
      requestId: 'im:om_second',
      expectedRunId: run.runId,
    });
    expect(run.steerCalls[0]?.prompt).toContain('<user_input>');
    expect(run.steerCalls[0]?.prompt).toContain('continue with this additional constraint');
    expect(run.steerCalls[0]?.prompt).not.toContain('start the task');

    run.complete();
    await waitFor(() => h.channel.sent.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(agent.runOptions).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain('FINAL_AFTER_STEER');
  });

  it('automatically merges an unmentioned follow-up in an exclusive human-agent group', async () => {
    const agent = new SteerableFakeAgent();
    const h = await createHarness({ agent, messageReply: 'text' });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message('om_group_first', 'start', { chatType: 'group', mentionedBot: true }),
    );
    await waitFor(() => agent.steeringRuns.length === 1);
    await h.channel.handlers.message?.(
      message('om_group_followup', 'also cover this', {
        chatType: 'group',
        mentionedBot: false,
      }),
    );

    const run = agent.steeringRuns[0];
    if (!run) throw new Error('expected the group run to be active');
    expect(run.steerCalls).toHaveLength(1);
    expect(run.steerCalls[0]?.requestId).toBe('im:om_group_followup');
  });

  it('does not treat a direct reply as addressing in a multi-person group', async () => {
    const agent = new SteerableFakeAgent();
    const h = await createHarness({
      agent,
      messageReply: 'text',
      requireMentionInGroup: false,
      groupHumanCount: 2,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message('om_multi_first', 'start', { chatType: 'group', mentionedBot: true }),
    );
    await waitFor(() => agent.steeringRuns.length === 1);
    await h.channel.handlers.message?.(
      message('om_multi_reply', 'reply context only', {
        chatType: 'group',
        mentionedBot: false,
        replyToMessageId: 'om_multi_first',
      }),
    );

    const run = agent.steeringRuns[0];
    if (!run) throw new Error('expected the group run to be active');
    expect(run.steerCalls).toHaveLength(0);
  });
});

describe('new-task escape hatch', () => {
  it('queues inline `/new` content as the first message of a fresh session', async () => {
    const h = await createHarness({ messageReply: 'text' });
    h.sessions.set('oc_dm', 'old-session', h.tmp.workspace);
    await startTestBridge(h);

    await h.channel.handlers.message?.(
      message('om_new_task', '/new implement the automatic follow-up behavior'),
    );
    await waitFor(() => h.agent.runOptions.length === 1);

    expect(h.sessions.getRaw('oc_dm')).toBeUndefined();
    expect(h.agent.runOptions[0]?.prompt).toContain('implement the automatic follow-up behavior');
    expect(h.agent.runOptions[0]?.prompt).not.toContain('/new implement');
  });
});

describe('markdown stream startup failures', () => {
  it('does not leave the IM queue blocked when the agent exits before stream producer starts', async () => {
    const h = await createHarness();
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    expect(h.channel.rawClient.im.v1.messageReaction.delete).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_first', reaction_id: 'reaction_1' },
      }),
    );
    expect(lastMarkdown(h.channel)).toContain('agent 失败');
    expect(lastMarkdown(h.channel)).toContain('codex exited with code 1');
  });

  it('does not wait for the working reaction before draining a failed agent run', async () => {
    const reaction = deferred<{ data: { reaction_id: string } }>();
    const h = await createHarness({
      reactionCreate: () => reaction.promise,
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => h.agent.runOptions.length === 1);

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2, 1000);

    expect(lastMarkdown(h.channel)).toContain('agent 失败');

    reaction.resolve({ data: { reaction_id: 'reaction_1' } });
    await waitFor(() => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0);
  });

  it('logs stream failures that arrive after terminal grace expires', async () => {
    const streamFailure = deferred<void>();
    let streamProducerStarted = false;
    const h = await createHarness({
      // The first run has to stream something, or no progress stream is opened
      // at all and there is no late failure to log.
      events: [
        [
          { type: 'text', delta: 'progress update' },
          {
            type: 'error',
            message: 'codex exited with code 1: Error loading config.toml',
            terminationReason: 'failed',
          },
        ],
        [{ type: 'done', terminationReason: 'normal' }],
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        if (producer) {
          streamProducerStarted = true;
          void producer({ setContent: vi.fn(async () => {}) });
        }
        await streamFailure.promise;
      },
    });
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_first', 'first'));
    await waitFor(() => streamProducerStarted);
    await waitFor(
      () => h.channel.rawClient.im.v1.messageReaction.delete.mock.calls.length > 0,
      4500,
    );

    await h.channel.handlers.message?.(message('om_second', 'second'));
    await waitFor(() => h.agent.runOptions.length === 2);

    streamFailure.reject(new Error('late stream failed'));

    await waitFor(() =>
      fail.mock.calls.some((call) =>
        call[0] === 'stream' &&
        call[1] instanceof Error &&
        call[1].message === 'late stream failed' &&
        (call[2] as { step?: string } | undefined)?.step === 'stream-terminal-late',
      ),
    );
  }, 10_000);

  it('sends one dedicated non-streaming final reply after progress completes', async () => {
    const visibleProgress: string[] = [];
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_final', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(visibleProgress.some((markdown) => markdown.includes('progress update'))).toBe(true);
    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain('FINAL_SENTINEL');
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_final' });
  });

  it('opens no progress stream for a final-only round', async () => {
    // The regression this guards: Codex answering without any commentary. The
    // SDK sends its streaming card as soon as `stream()` is called and finishes
    // an empty one with "(no content)", so the user saw that placeholder for a
    // few seconds, watched it get recalled, and only then got the answer.
    const streamCalls: unknown[] = [];
    const h = await createHarness({
      events: [
        { type: 'final_text', content: 'FINAL_ONLY_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        streamCalls.push(input);
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_final_only', 'run'));
    await waitFor(() => h.channel.sent.length === 1);
    // give a stray stream / recall a chance to fire before asserting
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(streamCalls).toHaveLength(0);
    expect(h.channel.sent).toHaveLength(1);
    expect(lastMarkdown(h.channel)).toContain('FINAL_ONLY_SENTINEL');
  });

  it('does not repeat streamed text as the final reply when Codex held nothing back', async () => {
    // Codex only reserves its *last* message as `final_text`; an abnormal turn
    // end (turn.failed, or the process dying before turn.completed) flushes it
    // as a text block instead. Those blocks are already on screen, so the
    // dedicated final reply must not post the same words a second time.
    const visibleProgress: string[] = [];
    const h = await createHarness({
      events: [
        { type: 'text', delta: '这是答案' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_no_final', 'run'));
    await waitFor(() => visibleProgress.some((markdown) => markdown.includes('这是答案')));
    // give a (duplicate) final reply a chance to fire before asserting
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.channel.sent).toHaveLength(0);
  });

  it('waits for a slow-opening progress stream instead of replying alongside it', async () => {
    // Opening a streaming card costs two API round trips. When the run finishes
    // first, replying right away duplicates the answer verbatim — once as text,
    // once as the card that lands a moment later.
    const visibleProgress: string[] = [];
    const h = await createHarness({
      agentKind: 'claude',
      events: [
        { type: 'text', delta: 'ANSWER_ONCE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await new Promise((resolve) => setTimeout(resolve, 200));
        await producer?.({
          setContent: vi.fn(async (markdown: string) => {
            visibleProgress.push(markdown);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_slow_stream', 'run'));
    await waitFor(() => visibleProgress.some((markdown) => markdown.includes('ANSWER_ONCE')));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(h.channel.sent).toHaveLength(0);
  });

  it('renders nothing in a progress stream it already gave up on', async () => {
    // If the stream is still not producing after the grace window we do reply
    // without it — but the stream must then stay empty, or the answer shows up
    // twice as soon as it catches up.
    const gate = deferred<void>();
    const setContent = vi.fn(async () => {});
    const h = await createHarness({
      agentKind: 'claude',
      events: [
        { type: 'text', delta: 'ANSWER_ONCE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await gate.promise;
        await producer?.({ setContent });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stuck_stream', 'run'));
    await waitFor(() => h.channel.sent.length === 1, 6000);
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(lastMarkdown(h.channel)).toContain('ANSWER_ONCE');
    expect(h.channel.sent).toHaveLength(1);
    expect(setContent).not.toHaveBeenCalled();
  }, 15_000);

  it('still sends the final reply when the progress stream fails at completion', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const h = await createHarness({
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_AFTER_STREAM_FAILURE' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
        throw new Error('progress stream failed');
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_stream_fail', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    expect(lastMarkdown(h.channel)).toContain('FINAL_AFTER_STREAM_FAILURE');
    expect(
      fail.mock.calls.some(
        (call) =>
          call[0] === 'stream' &&
          call[1] instanceof Error &&
          call[1].message === 'progress stream failed' &&
          (call[2] as { step?: string } | undefined)?.step === 'progress-stream',
      ),
    ).toBe(true);
  });

  it('does not record delivery when the final send has no message receipt', async () => {
    const fail = vi.spyOn(log, 'fail').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const h = await createHarness({
      events: [
        { type: 'final_text', content: 'FINAL_WITHOUT_RECEIPT' },
        { type: 'done', terminationReason: 'normal' },
      ],
      send: async () => ({ messageId: '' }),
      stream: async (_chatId, input) => {
        const producer = (input as {
          markdown?: (ctrl: { setContent(markdown: string): Promise<void> }) => Promise<void>;
        }).markdown;
        await producer?.({ setContent: vi.fn(async () => {}) });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_no_receipt', 'run'));
    await waitFor(() =>
      fail.mock.calls.some(
        (call) => call[1] instanceof Error && call[1].message.includes('missing message receipt'),
      ),
    );

    expect(
      info.mock.calls.some((call) => call[0] === 'outbound' && call[1] === 'sent'),
    ).toBe(false);
  });

  it('sends one dedicated final reply card after progress completes in card mode', async () => {
    const progressCards: unknown[] = [];
    const h = await createHarness({
      messageReply: 'card',
      events: [
        { type: 'text', delta: 'progress update' },
        { type: 'final_text', content: 'FINAL_SENTINEL' },
        { type: 'done', terminationReason: 'normal' },
      ],
      stream: async (_chatId, input) => {
        const producer = (input as {
          card?: { producer?: (ctrl: { update(next: unknown): Promise<void> }) => Promise<void> };
        }).card?.producer;
        await producer?.({
          update: vi.fn(async (next: unknown) => {
            progressCards.push(next);
          }),
        });
      },
    });
    await startTestBridge(h);

    await h.channel.handlers.message?.(message('om_card_final', 'run'));
    await waitFor(() => h.channel.sent.length === 1);

    // Intermediate agent messages stream as progress; the final answer never
    // leaks into the progress card (it is held back for the dedicated reply).
    const progressJson = JSON.stringify(progressCards);
    expect(progressJson).toContain('progress update');
    expect(progressJson).not.toContain('FINAL_SENTINEL');

    // The terminal answer arrives as exactly one non-streaming card send.
    expect(h.channel.sent).toHaveLength(1);
    const finalJson = JSON.stringify(h.channel.sent[0]?.content);
    expect(finalJson).toContain('FINAL_SENTINEL');
    expect(finalJson).not.toContain('progress update');
    expect(h.channel.sent[0]?.options).toMatchObject({ replyTo: 'om_card_final' });
  });
});

async function createHarness(options: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  send?: SendFn;
  /** One run's events, or one array per run. */
  events?: FakeAgentEvents;
  messageReply?: 'card' | 'markdown' | 'text';
  /** Codex holds its answer back for a dedicated final reply; Claude streams it. */
  agentKind?: 'claude' | 'codex';
  /** Inject a specialized adapter for active-turn lifecycle tests. */
  agent?: FakeAgentAdapter;
  requireMentionInGroup?: boolean;
  groupHumanCount?: number;
  groupBotCount?: number;
} = {}): Promise<{
  tmp: TmpProfile;
  channel: FakeLarkChannel;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  controls: ReturnType<typeof createControls>;
}> {
  const tmp = await createTmpProfile('markdown-stream-startup-failure-');
  const workspace = await realpath(tmp.workspace);
  const baseProfileConfig = createDefaultProfileConfig({
    agentKind: options.agentKind ?? 'codex',
    accounts: {
      app: {
        id: 'cli_test',
        secret: 'secret',
        tenant: 'feishu',
      },
    },
    access: {
      allowedUsers: ['ou_user'],
      allowedChats: ['oc_group'],
      ...(options.requireMentionInGroup !== undefined
        ? { requireMentionInGroup: options.requireMentionInGroup }
        : {}),
    },
    codex: {
      binaryPath: '/usr/local/bin/codex',
    },
    preferences: {
      cotMessages: 'off',
      ...(options.messageReply ? { messageReply: options.messageReply } : {}),
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
  const agent = options.agent ?? new FakeAgentAdapter({
    id: 'codex',
    displayName: 'Codex',
    events: options.events ?? [
      [
        {
          type: 'error',
          message: 'codex exited with code 1: Error loading config.toml',
          terminationReason: 'failed',
        },
      ],
      [{ type: 'done', terminationReason: 'normal' }],
    ],
  });
  const channel = createFakeLarkChannel(options);
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

class SteerableFakeAgent extends FakeAgentAdapter {
  readonly steeringRuns: SteerableFakeRun[] = [];

  constructor() {
    super({ id: 'codex', displayName: 'Codex' });
  }

  override run(opts: AgentRunOptions): AgentRun {
    this.runOptions.push(opts);
    const run = new SteerableFakeRun(opts);
    this.runs.push(run);
    this.steeringRuns.push(run);
    return run;
  }
}

class SteerableFakeRun implements FakeAgentRun {
  readonly runId: string;
  readonly opts: AgentRunOptions;
  readonly events: AsyncIterable<AgentEvent>;
  readonly steering = { mode: 'direct' as const, textOnly: true };
  readonly steerCalls: AgentSteeringRequest[] = [];
  readonly waitForExitResult = true;
  private readonly gate = deferred<void>();
  private readonly exited = deferred<void>();
  private stopRequested = false;
  private waitCalls = 0;

  constructor(opts: AgentRunOptions) {
    this.runId = opts.runId;
    this.opts = opts;
    this.events = this.iterate();
  }

  get stopped(): boolean {
    return this.stopRequested;
  }

  get waitForExitCalls(): number {
    return this.waitCalls;
  }

  async steer(request: AgentSteeringRequest) {
    this.steerCalls.push(request);
    return { kind: 'accepted' as const, runId: this.runId };
  }

  complete(): void {
    this.gate.resolve();
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.gate.resolve();
  }

  async waitForExit(): Promise<boolean> {
    this.waitCalls++;
    await this.exited.promise;
    return true;
  }

  private async *iterate(): AsyncIterable<AgentEvent> {
    try {
      await this.gate.promise;
      if (!this.stopRequested) {
        yield { type: 'final_text', content: 'FINAL_AFTER_STEER' };
      }
      yield {
        type: 'done',
        terminationReason: this.stopRequested ? 'interrupted' : 'normal',
      };
    } finally {
      this.exited.resolve();
    }
  }
}

async function startTestBridge(h: {
  profileConfig: ReturnType<typeof createDefaultProfileConfig>;
  agent: FakeAgentAdapter;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  controls: ReturnType<typeof createControls>;
}): Promise<void> {
  const bridge = await startChannel({
    cfg: h.profileConfig,
    agent: h.agent,
    sessions: h.sessions,
    workspaces: h.workspaces,
    controls: h.controls,
  });
  cleanups.push(() => bridge.disconnect());
}

function createFakeLarkChannel(harnessOptions: {
  reactionCreate?: () => Promise<{ data: { reaction_id: string } }>;
  stream?: StreamFn;
  send?: SendFn;
  groupHumanCount?: number;
  groupBotCount?: number;
} = {}): FakeLarkChannel {
  const handlers: MessageHandlerMap = {};
  const sent: FakeLarkChannel['sent'] = [];
  const channel: FakeLarkChannel = {
    handlers,
    sent,
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
          },
          messageReaction: {
            create: vi.fn(harnessOptions.reactionCreate ?? (async () => ({ data: { reaction_id: 'reaction_1' } }))),
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
    async getChatMembers() {
      return Array.from({ length: harnessOptions.groupHumanCount ?? 1 }, (_, index) => ({
        id: `ou_user_${index}`,
      }));
    },
    async getChatBots() {
      return Array.from({ length: harnessOptions.groupBotCount ?? 1 }, (_, index) => ({
        id: `ou_bot_${index}`,
        isBot: true as const,
      }));
    },
    getConnectionStatus() {
      return { state: 'connected', reconnectAttempts: 0 };
    },
    async send(chatId, content, options) {
      sent.push({ chatId, content, options });
      if (harnessOptions.send) return harnessOptions.send(chatId, content, options);
      return { messageId: `sent_${sent.length}` };
    },
    stream: harnessOptions.stream ?? (async () => {
      await new Promise<void>(() => {});
    }),
    async addReaction(messageId, emojiType) {
      const r = await channel.rawClient.im.v1.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      return (r as { data?: { reaction_id?: string } })?.data?.reaction_id ?? '';
    },
    async removeReaction(messageId, reactionId) {
      await channel.rawClient.im.v1.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    },
  };
  return channel;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createControls(profileConfig: ReturnType<typeof createDefaultProfileConfig>) {
  return {
    profile: 'codex',
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

function message(
  messageId: string,
  content: string,
  options: {
    chatType?: 'p2p' | 'group';
    mentionedBot?: boolean;
    replyToMessageId?: string;
  } = {},
): NormalizedMessage {
  const chatType = options.chatType ?? 'p2p';
  const mentionedBot = options.mentionedBot ?? false;
  return {
    messageId,
    chatId: chatType === 'p2p' ? 'oc_dm' : 'oc_group',
    chatType,
    senderId: 'ou_user',
    senderName: 'User',
    content,
    rawContentType: 'text',
    resources: [],
    mentions: mentionedBot
      ? [{ key: '@_user_1', openId: 'ou_bot', name: 'Bridge', isBot: true }]
      : [],
    mentionedBot,
    ...(options.replyToMessageId ? { replyToMessageId: options.replyToMessageId } : {}),
    createTime: 1760000001000,
  } as unknown as NormalizedMessage;
}

function lastMarkdown(channel: FakeLarkChannel): string {
  const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
  expect(content?.markdown).toBeTypeOf('string');
  return content?.markdown ?? '';
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
