import { describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@larksuite/channel';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import type { RuntimeControls } from '../../../src/policy/access';
import { PersonalAgentGroups, PersonalGroupPeers } from '../../../src/bot/personal-agent-group';
import { readLarkRoster } from '../../../src/bot/lark-group-roster';

function fixture() {
  const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app: { id: 'cli_test', secret: 'test', tenant: 'feishu' } } });
  const controls: RuntimeControls = { ownerRefreshState: 'ok', botOwnerId: 'human' };
  const peers = new PersonalGroupPeers();
  peers.register('feishu', 'self');
  const removePeer = peers.register('feishu', 'peer');
  const roster = { humans: ['human'], agents: ['self', 'peer'] };
  const request = vi.fn(async (input: { url: string }) => ({ code: 0, data: {
    items: input.url.endsWith('/bots') ? roster.agents.map(bot_id => ({ bot_id }))
      : roster.humans.map(member_id => ({ member_id, member_id_type: 'open_id' })),
    has_more: false,
  } }));
  const channel = { rawClient: { request }, botIdentity: { openId: 'self' } };
  const groups = new PersonalAgentGroups({ channel: channel as never, domain: 'feishu',
    peers, profile: () => profile, controls });
  const message = { chatId: 'chat', chatType: 'group', senderId: 'peer', senderType: 'bot',
    mentionedBot: true } as NormalizedMessage;
  return { profile, controls, peers, removePeer, roster, request, groups, message, channel };
}

describe('personal agent group admission', () => {
  it('admits an addressed connected peer without persisting a chat allowlist', async () => {
    const f = fixture();
    const proof = await f.groups.admit(f.message);
    expect(proof).toMatchObject({ humanId: 'human', agentIds: ['self', 'peer'] });
    expect(f.profile.access.allowedChats).toEqual([]);
    await expect(f.groups.refresh(proof!)).resolves.toBeUndefined();
    expect(await f.groups.status('chat')).toContain('自动启用');
  });

  it('admits the sole owner or configured administrator with provider sender identity', async () => {
    const f = fixture();
    const message = { ...f.message, senderId: 'human', senderType: 'user' as const };
    expect(await f.groups.admit(message)).toBeDefined();
    f.controls.ownerRefreshState = 'failed';
    expect(await f.groups.admit(message)).toBeUndefined();
    f.profile.access.admins.push('human');
    expect(await f.groups.admit(message)).toBeDefined();
  });

  it.each(['no-mention', 'unknown-sender', 'self-sender', 'foreign-chat', 'user-spoof'])('rejects %s', async scenario => {
    const f = fixture();
    const proof = (await f.groups.admit(f.message))!;
    const msg = { ...f.message };
    if (scenario === 'no-mention') msg.mentionedBot = false;
    if (scenario === 'unknown-sender') msg.senderType = undefined;
    if (scenario === 'self-sender') msg.senderId = 'self';
    if (scenario === 'foreign-chat') msg.chatId = 'foreign';
    if (scenario === 'user-spoof') msg.senderType = 'user';
    expect(f.groups.accepts(proof, msg)).toBe(false);
  });

  it.each(['second-human', 'unknown-bot', 'offline-peer', 'owner-revoked', 'failed-roster', 'duplicate-agent'])('revokes queued/publication evidence on %s', async scenario => {
    const f = fixture();
    const proof = (await f.groups.admit(f.message))!;
    if (scenario === 'second-human') f.roster.humans.push('another');
    if (scenario === 'unknown-bot') f.roster.agents.push('external');
    if (scenario === 'offline-peer') f.removePeer();
    if (scenario === 'owner-revoked') f.controls.botOwnerId = 'different';
    if (scenario === 'failed-roster') f.request.mockRejectedValue(new Error('offline'));
    if (scenario === 'duplicate-agent') f.roster.agents.push('peer');
    await expect(f.groups.refresh(proof)).rejects.toThrow('changed');
    expect(await f.groups.admit(f.message)).toBeUndefined();
  });

  it('does not accept copied proof objects or a different authority', async () => {
    const f = fixture();
    const proof = (await f.groups.admit(f.message))!;
    await expect(f.groups.refresh({ ...proof })).rejects.toThrow('untrusted');
    await expect(fixture().groups.refresh(proof)).rejects.toThrow('untrusted');
  });

  it('leaves team, manually enabled groups and one-bot addressing on their existing paths', async () => {
    const f = fixture();
    f.profile.mode = 'team';
    expect(await f.groups.admit(f.message)).toBeUndefined();
    f.profile.mode = 'personal';
    f.profile.access.allowedChats.push('chat');
    expect(await f.groups.admit(f.message)).toBeUndefined();
    f.profile.access.allowedChats.length = 0;
    f.roster.agents.pop();
    expect(await f.groups.admit(f.message)).toBeUndefined();
  });

  it('does not mix domains or revoke a newer registration when an old connection closes', () => {
    const peers = new PersonalGroupPeers();
    const old = peers.register('feishu', 'peer');
    const current = peers.register('feishu', 'peer');
    old();
    expect(peers.has('feishu', 'peer')).toBe(true);
    expect(peers.has('lark', 'peer')).toBe(false);
    current();
    expect(peers.has('feishu', 'peer')).toBe(false);
  });
});

describe('complete roster evidence', () => {
  it('reads all human pages so a second human cannot be hidden by pagination', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ data: { items: [{ member_id: 'first' }], has_more: true, page_token: 'next' } })
      .mockResolvedValueOnce({ data: { items: [{ member_id: 'second' }], has_more: false } });
    expect(await readLarkRoster({ rawClient: { request } } as never, 'chat', 'users')).toEqual(['first', 'second']);
    expect(request.mock.calls[1]?.[0].params.page_token).toBe('next');
  });

  it.each([
    { items: [{ member_id: 'first' }] },
    { items: [{ member_id: 'first' }], has_more: true },
    { items: [{ member_id: 'first', member_id_type: 'user_id' }], has_more: false },
  ])('rejects incomplete or incompatible human evidence', async data => {
    const request = vi.fn().mockResolvedValue({ data });
    await expect(readLarkRoster({ rawClient: { request } } as never, 'chat', 'users')).rejects.toThrow();
  });
});
