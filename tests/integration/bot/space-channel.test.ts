import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createFakeChannel } from '../../helpers/fake-channel';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { gateFixture } from '../../helpers/space-gate';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { createAdapterRuntime } from '../../../src/agent/runtime/adapter-runtime';
import { composeProfileExecution } from '../../../src/conversation/composition';
import { SessionStore } from '../../../src/session/store';
import { WorkspaceStore } from '../../../src/workspace/store';
import { LarkSpaceIdentity } from '../../../src/bot/lark-space-identity';
import { SpaceOperationGate } from '../../../src/space/operation-gate';
const sdk = vi.hoisted(() => ({ channel: undefined as unknown }));
vi.mock('@larksuite/channel', async original => ({ ...await original<typeof import('@larksuite/channel')>(), createLarkChannel: () => sdk.channel }));
import { startChannel } from '../../../src/bot/channel';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); sdk.channel = undefined; });
it('M3/I2/I3/E5: real Lark intake, commands and final output share one authority, including an explicitly mentioned solo group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-lark-space-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const agents: FakeAgentAdapter[] = [];
  const f = await gateFixture(root, { create: async () => {
    const agent = new FakeAgentAdapter({ id: 'claude', events: [1, 2, 3].map(() => [{ type: 'system' as const, sessionId: 'native-' + agents.length },
      { type: 'text' as const, delta: 'space answer' }, { type: 'done' as const, terminationReason: 'normal' as const }]) });
    agents.push(agent); return createAdapterRuntime(agent);
  } }); cleanups.push(() => f.services.close());
  const handlers: { message?: (msg: NormalizedMessage) => Promise<void> } = {};
  const fake = createFakeChannel();
  let beforeHistory = () => {};
  const projected: string[] = [];
  sdk.channel = { ...fake, botIdentity: { openId: 'bot', name: 'Bot' },
    rawClient: { im: { v1: { message: { list: vi.fn(async () => { beforeHistory(); return ({ code: 0, data: {
      items: [{ message_id: 'own-progress-history', sender: { id: 'bot', sender_type: 'app', open_bot_id: 'bot' },
        msg_type: 'text', body: { content: JSON.stringify({ text: 'working' }) }, create_time: String(Date.now()) }], has_more: false,
    } }); }) } } }, request: vi.fn(async ({ url }: { url: string }) => ({ code: 0, data: {
      items: url.endsWith('/bots') ? [{ bot_id: 'bot' }] : f.state.humans.map(id => ({ member_id: id, member_id_type: 'open_id' })), has_more: false,
    } })) },
    on: (value: typeof handlers) => Object.assign(handlers, value), connect: async () => undefined, disconnect: async () => undefined,
    getChatInfo: async () => ({ name: 'Test group' }),
    getChatMode: async (id: string) => id.startsWith('dm') ? 'p2p' : 'group',
    getChatMembers: async () => f.state.humans.map(id => ({ id })), getChatBots: async () => [{ id: 'bot', isBot: true }],
    getConnectionStatus: () => ({ state: 'connected', reconnectAttempts: 0 }),
    addReaction: async () => 'reaction', removeReaction: async () => undefined,
  };
  const cfg = createDefaultProfileConfig({ agentKind: 'claude', mode: 'team', accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } },
    access: { allowedChats: ['group-1'], allowedUsers: ['a', 'b'] } });
  cfg.workspaces.default = root;
  const controls = { profile: 'profile', profileConfig: cfg, cfg, configPath: join(root, 'config.json'), processId: 'test',
    ownerRefreshState: 'unknown' as const, refreshOwner: async () => undefined, restart: async () => undefined, exit: async () => undefined };
  const sessions = new SessionStore(join(root, 'legacy.json')); const workspaces = new WorkspaceStore(join(root, 'legacy-workspaces.json'));
  const agent = new FakeAgentAdapter({ id: 'claude' });
  const owner = composeProfileExecution({ profileId: 'profile', spaces: f.services, agent, sessions, workspaces, maxConcurrentRuns: () => 2 });
  cleanups.push(() => owner.close());
  let gate!: SpaceOperationGate;
  let cotCounter = 0;
  const cotClient = { create: vi.fn(async () => ({ cot_id: `cot-${++cotCounter}`, message_id: `bubble-${cotCounter}` })),
    update: vi.fn(async () => {}), complete: vi.fn(async () => {}) };
  const bridge = await startChannel({ cfg, controls, agent, sessions, workspaces, conversationRuntime: owner, cotClient,
    messageRead: { scope: 'space', observe: async event => {
      if (event.direction !== 'outbound') return;
      const operation = gate.active();
      expect(event.conversationKey).toBe(operation.executionScope);
      if (event.sourceMessageId) projected.push(event.sourceMessageId);
    }, bind: async () => {}, remove: async () => {} },
    createSpaceGate: async raw => gate = new SpaceOperationGate(f.services,
      new LarkSpaceIdentity({ authorization: f.authorization, channel: raw, appId: 'fixture', instanceId: 'primary', now: () => f.state.now }),
      f.grants, () => ({ admitted: true, accessCeiling: 'workspace' }), () => f.state.now, f.resources) });
  cleanups.push(() => bridge.disconnect());
  const receive = async (chatId: string, id: string, text = 'hello', user = 'a') => handlers.message!(message(chatId, id, text, user));
  await receive('dm-a', 'one');
  // A mode transition may begin during debounce. The admitted message still
  // runs, while a fresh callback cannot enter or alter its queue/state.
  const resumeIngress = owner.runtime.ingress.pause();
  await expect(receive('dm-a', 'not-admitted')).rejects.toThrow('not accepted');
  expect(bridge.activitySnapshot().decision).toBe('busy');
  await vi.waitFor(() => expect(fake.sent.some(m => JSON.stringify(m.content).includes('space answer'))).toBe(true), { timeout: 4000 });
  expect(agents[0]?.runOptions[0]?.identity).toMatchObject({ providerId: 'lark', subjectId: 'bot', displayName: 'Bot' });
  await vi.waitFor(() => expect(bridge.activitySnapshot().decision).toBe('safe'));
  expect(owner.runtime.activeRuns.newRunsPaused()).toBe(false);
  resumeIngress();
  const dm = await gate.enter({ conversationId: 'dm-a', senderId: 'a', senderKind: 'user', kind: 'direct' }, 'dm-a');
  await receive('group-1', 'two');
  await vi.waitFor(() => expect(fake.sent.filter(m => JSON.stringify(m.content).includes('space answer'))).toHaveLength(2), { timeout: 4000 });
  const solo = await gate.enter({ conversationId: 'group-1', senderId: 'a', senderKind: 'user', kind: 'group' }, 'group-1');
  expect(f.authorization.inspect(dm.context).binding.spaceId).toBe(f.authorization.inspect(solo.context).binding.spaceId);
  expect(dm.executionScope).not.toBe(solo.executionScope);
  expect(agents).toHaveLength(1); expect(agents[0]!.runOptions).toHaveLength(2);
  expect(agents[0]!.runOptions[1]!.sessionId).toBeUndefined();
  await vi.waitFor(() => expect(bridge.activitySnapshot().decision).toBe('safe'));
  await receive('group-1', 'continue', 'continue');
  await vi.waitFor(() => expect(fake.sent.filter(m => JSON.stringify(m.content).includes('space answer'))).toHaveLength(3), { timeout: 4000 });
  expect(agents).toHaveLength(1);
  expect(agents[0]!.runOptions[2]!.sessionId).toBe('native-0');
  expect((await gate.enter({ conversationId: 'group-1', senderId: 'a', senderKind: 'user', kind: 'group' }, 'group-1')).executionScope).toBe(solo.executionScope);
  await receive('group-1', 'new', '/new');
  expect((await f.services.state.view(dm.context)).sessionCatalog.entries().some(e => e.scopeId === dm.executionScope && e.status === 'active')).toBe(true);
  f.state.humans = ['a', 'b'];
  await expect(gate.run(solo, () => bridge.channel.send('group-1', { text: 'late private answer' }))).rejects.toThrow('audience changed');
  await receive('group-1', 'three');
  await vi.waitFor(() => expect(agents).toHaveLength(2), { timeout: 4000 });
  await vi.waitFor(() => expect(fake.sent.filter(m => JSON.stringify(m.content).includes('space answer'))).toHaveLength(4), { timeout: 4000 });
  expect(JSON.stringify(fake.sent)).not.toContain('late private answer');
  expect(fake.streams).toEqual([]);
  expect(cotClient.create).toHaveBeenCalledTimes(4);
  await vi.waitFor(() => expect(bridge.activitySnapshot().decision).toBe('safe'));
  // A real roster change during history refresh must suppress the answer but
  // project the interruption notice under the newly authorized execution scope.
  beforeHistory = () => { f.state.humans = ['a', 'b', 'c']; };
  await receive('group-1', 'changed');
  await vi.waitFor(() => expect(fake.sent.some(m => JSON.stringify(m.content).includes('会话成员或访问权限已变化'))).toBe(true), { timeout: 4000 });
  await vi.waitFor(() => expect(bridge.activitySnapshot().decision).toBe('safe'));
  expect(fake.sent.filter(m => JSON.stringify(m.content).includes('space answer'))).toHaveLength(4);
  expect(projected).toContain(`om_fake_${fake.sent.length}`);

  expect(cotClient.create).toHaveBeenNthCalledWith(2, 'group-1', 'two');
  expect(cotClient.update).toHaveBeenCalled();
  expect(bridge.activitySnapshot().presentation).toMatchObject({
    configured: { cotMessages: 'detailed' }, effective: { cotMessages: 'detailed', progress: 'cot' }, reasons: [],
  });
});
function message(chatId: string, messageId: string, content: string, senderId: string): NormalizedMessage {
  return { messageId, chatId, chatType: chatId.startsWith('dm') ? 'p2p' : 'group', senderId, senderType: 'user', content,
    rawContentType: 'text', resources: [], mentions: [{ key: '@_user_1', openId: 'bot', name: 'Bot', isBot: true }],
    mentionedBot: true, mentionAll: false, createTime: Date.now(), raw: { sender: { sender_type: 'user', sender_id: { open_id: senderId } } },
  } as unknown as NormalizedMessage;
}
