import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { gateFixture, directRequest } from '../../helpers/space-gate';
import { SpaceOperationLedger } from '../../../src/space/operation-ledger';
import { SpaceOperationGate } from '../../../src/space/operation-gate';
import { spaceLarkChannel } from '../../../src/outbound/space-lark-channel';
import type { LarkChannel } from '@larksuite/channel';
const roots: string[] = [];
async function root() { const p = await mkdtemp(join(tmpdir(), 'aria-space-gate-')); roots.push(p); return p; }
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });

describe('source and result ownership', () => {
  it('does not merge a less privileged sender into another sender\'s more privileged execution', async () => {
    const f = await gateFixture(await root()); f.state.humans = ['a', 'b'];
    const gate = new SpaceOperationGate(f.services, f.gate.identity, f.grants,
      request => ({ admitted: true, accessCeiling: request.senderId === 'a' ? 'workspace' : 'read-only' }), () => f.state.now);
    const request = { ...directRequest('a', 'group'), kind: 'group' as const };
    const a = await gate.enter(request, 'group'); const b = await gate.enter({ ...request, senderId: 'b' }, 'group');
    await expect(gate.batch([a, b])).rejects.toThrow('incompatible');
    expect(await gate.batch([b, a])).toBe(b);
    await f.services.close();
  });
  it('A4/X3: a reduced retained grant stays revoked after restart even if the profile ceiling rises again', async () => {
    const directory = await root(); const first = await gateFixture(directory, { persistent: true });
    const operation = await first.gate.enter(directRequest(), 'dm-a');
    const checkpoint = await first.gate.checkpoint(operation);
    first.state.access = 'read-only';
    await expect(first.gate.refresh(operation)).rejects.toThrow('reduced');
    await first.services.close();
    const second = await gateFixture(directory, { persistent: true });
    try { await expect(second.gate.restore(checkpoint)).rejects.toThrow('unavailable'); }
    finally { await second.services.close(); }
  });
  it('rechecks admission, reduced permissions, original destination and opaque handle authenticity', async () => {
    const f = await gateFixture(await root());
    const operation = await f.gate.enter(directRequest(), 'dm-a');
    await expect(f.gate.run({ ...operation }, async () => undefined)).rejects.toThrow('untrusted');
    const send = vi.fn(async () => undefined);
    await expect(f.gate.run(operation, () => f.gate.deliver('dm-b', send))).rejects.toThrow('foreign');
    expect(send).not.toHaveBeenCalled();
    f.state.access = 'read-only';
    await expect(f.gate.refresh(operation)).rejects.toThrow('reduced');
    const newer = await f.gate.enter(directRequest(), 'dm-a');
    f.state.admitted = false;
    await expect(f.gate.refresh(newer)).rejects.toThrow('access-denied');
    await expect(f.gate.run(newer, send)).rejects.toThrow();
    await f.services.close();
  });
  it('D2/X4: a saved answer survives restart but cannot move to a new private/shared epoch', async () => {
    const directory = await root();
    const first = await gateFixture(directory, { persistent: true });
    const request = { ...directRequest('a', 'group'), kind: 'group' as const };
    const operation = await first.gate.enter(request, 'group:thread');
    const ledger = new SpaceOperationLedger(first.gate, join(directory, 'answers.json')); await ledger.load();
    await ledger.capture('answer', operation, { text: 'private result' });
    await first.resources.record(operation.context, 'message', 'old-card');
    await first.services.close();
    const second = await gateFixture(directory, { persistent: true });
    const restored = new SpaceOperationLedger(second.gate, join(directory, 'answers.json')); await restored.load();
    const old = await restored.restore('answer', { text: 'private result' });
    expect(second.resources.owns(old.context, 'message', 'old-card')).toBe(true);
    second.state.humans = ['a', 'b'];
    await expect(restored.restore('answer', { text: 'private result' })).rejects.toThrow('audience changed');
    second.state.humans = ['a'];
    const fresh = await second.gate.enter(request, 'group:thread');
    expect(fresh.bindingRef).not.toBe(old.bindingRef);
    expect(second.resources.owns(fresh.context, 'message', 'old-card')).toBe(false);
    await expect(second.resources.record(fresh.context, 'message', 'old-card')).rejects.toThrow('retired');
    await second.services.close();
  });
  it('fences concrete Lark sends, card updates and attachment/quote reads', async () => {
    const f = await gateFixture(await root());
    const operation = await f.gate.enter(directRequest(), 'dm-a');
    const raw = { send: vi.fn(async () => ({ messageId: 'answer' })), editMessage: vi.fn(async () => undefined),
      fetchMessage: vi.fn(async () => undefined), createCard: vi.fn(async () => ({ cardId: 'card' })),
      updateCard: vi.fn(async () => undefined), fetchRawMessage: vi.fn(async () => []), downloadResource: vi.fn(async () => Buffer.from('x')) };
    const channel = spaceLarkChannel(raw as unknown as LarkChannel, f.gate);
    await expect(channel.send('dm-a', { text: 'unbound' })).rejects.toThrow('original space');
    await f.gate.run(operation, async () => {
      await f.resources.record(operation.context, 'message', 'input');
      await channel.send('dm-a', { text: 'owned' }, { replyTo: 'input' });
      await channel.updateCard('answer', { schema: '2.0', body: { elements: [] } });
      await expect(channel.fetchRawMessage('foreign')).rejects.toThrow('matching space');
      await expect(channel.downloadResource('foreign', 'key', 'image')).rejects.toThrow('matching space');
      await expect(channel.updateCard('foreign', {})).rejects.toThrow('matching space');
      await expect(channel.editMessage('foreign', 'x')).rejects.toThrow('matching space');
      await expect(channel.fetchMessage('foreign')).rejects.toThrow('matching space');
      await expect(channel.reply({ chatId: 'dm-b', messageId: 'input' }, { text: 'x' })).rejects.toThrow('foreign');
      expect(() => channel.rawClient).toThrow('bound adapter');
    });
    expect(raw.send).toHaveBeenCalledTimes(1);
    expect(raw.updateCard).toHaveBeenCalledTimes(1);
    expect(raw.fetchRawMessage).not.toHaveBeenCalled();
    await f.services.close();
  });
});

it('history rejection never suspends the owner and recovered peers retain their own access ceiling', async () => {
  const f = await gateFixture(await root());
  f.state.humans = ['a', 'b'];
  const gate = new SpaceOperationGate(f.services, f.gate.identity, f.grants,
    request => ({ admitted: request.senderId !== 'denied', accessCeiling: request.senderId === 'a' ? 'workspace' : 'read-only' }), () => f.state.now);
  try {
    const request = { ...directRequest('a', 'group'), kind: 'group' as const };
    const owner = await gate.enter(request, 'group');
    const peer = await gate.admitHistory(owner, { ...request, senderId: 'b' });
    expect(peer.bindingRef).toBe(owner.bindingRef);
    expect(f.authorization.inspect(peer.context).accessCeiling).toBe('read-only');
    await expect(gate.batch([owner, peer])).rejects.toThrow('incompatible');
    for (const senderId of ['denied', 'departed']) {
      await expect(gate.admitHistory(owner, { ...request, senderId })).rejects.toThrow();
      expect(f.authorization.inspect(owner.context).binding.version).toBe(1);
    }
    f.state.complete = false;
    await expect(gate.admitHistory(owner, request)).rejects.toThrow('audience-unverified');
    expect(f.authorization.inspect(owner.context).binding.version).toBe(1);
    f.state.complete = true;
    await gate.refresh(owner);
    await expect(gate.admitHistory({ ...owner }, request)).rejects.toThrow('untrusted');
    await expect(gate.admitHistory(owner, { ...request, conversationId: 'foreign' })).rejects.toThrow('audience');
    f.state.humans.push('new-member');
    await expect(gate.admitHistory(owner, request)).rejects.toThrow('audience');
    // Original-authority refresh, unlike history checks, must revoke a changed audience.
    await expect(gate.deliver('group', async () => undefined)).rejects.toThrow();
    await expect(gate.run(owner, async () => undefined)).rejects.toThrow('audience changed');
  } finally { await f.services.close(); }
});
