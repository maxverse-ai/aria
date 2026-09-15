import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gateFixture, directRequest } from '../../helpers/space-gate';
import { describe, it, expect, vi } from 'vitest';
import type { SpaceOperationGate } from '../../../src/space/operation-gate';
import { fetchSpaceFreshnessHistory } from '../../../src/bot/space-freshness-history';
import type { fetchFreshnessHistory } from '../../../src/bot/freshness-history';
import type { ConversationInput } from '../../../src/bot/conversation-input';

describe('space-bound history', () => {
  function setup() {
    const original = { request: { conversationId: 'chat', kind: 'group' }, scopeRef: 'chat:thread',
      bindingRef: 'binding', executionScope: 'space-thread', context: {} };
    const gate = { active: () => original, refresh: vi.fn(async () => {}),
      admitHistory: vi.fn(async () => original), resources: { record: vi.fn(async () => {}) } };
    const input = { chatId: 'chat', threadId: 'thread', chatType: 'group', afterMs: 1, knownInputIds: new Set() } as unknown as Parameters<typeof fetchFreshnessHistory>[0];
    const entry = { message: { messageId: 'm1', senderId: 'peer' }, senderType: 'bot' } as ConversationInput;
    const fetch = vi.fn(async () => ({ status: 'complete' as const, inputs: [entry] }));
    return { original, gate, input, fetch };
  }
  it('denies foreign conversations and threads before any read', async () => {
    const h = setup();
    for (const input of [{ ...h.input, chatId: 'other' }, { ...h.input, threadId: undefined }]) {
      await expect(fetchSpaceFreshnessHistory(h.gate as unknown as SpaceOperationGate, input, h.fetch)).rejects.toThrow('audience');
    }
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it('attaches independently admitted operations to the recovered input', async () => {
    const h = setup();
    const result = await fetchSpaceFreshnessHistory(h.gate as unknown as SpaceOperationGate, h.input, h.fetch);
    expect(result.inputs[0]?.spaceOperation).toBe(h.original);
    expect(h.gate.admitHistory).toHaveBeenCalledWith(h.original, { conversationId: 'chat', senderId: 'peer', senderKind: 'agent', kind: 'group' });
    expect(h.gate.refresh).toHaveBeenCalledTimes(3);
  });
  it('does not turn denied history senders into queued work', async () => {
    const h = setup();
    h.gate.admitHistory.mockRejectedValue(new Error('denied'));
    expect((await fetchSpaceFreshnessHistory(h.gate as unknown as SpaceOperationGate, h.input, h.fetch)).inputs).toEqual([]);
    expect(h.gate.resources.record).not.toHaveBeenCalled();
  });
  it('does not release fetched content after authority is revoked during the read', async () => {
    const h = setup();
    h.gate.refresh.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('revoked'));
    await expect(fetchSpaceFreshnessHistory(h.gate as unknown as SpaceOperationGate, h.input, h.fetch)).rejects.toThrow('revoked');
    expect(h.gate.resources.record).not.toHaveBeenCalled();
  });
});

// Use the real gate and binding store: mocking enter concealed its mutation.
it('keeps a solo group bound across bot history and consecutive replies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-history-binding-'));
  const f = await gateFixture(root);
  try {
    const request = { ...directRequest('a', 'chat'), kind: 'group' as const };
    const original = await f.gate.enter(request, 'chat');
    const input = { chatId: 'chat', chatType: 'group', afterMs: 1, knownInputIds: new Set() } as unknown as Parameters<typeof fetchFreshnessHistory>[0];
    const history = async () => ({ status: 'complete' as const, inputs: [
      { message: { messageId: 'progress', senderId: 'bot' }, senderType: 'bot' },
      { message: { messageId: 'departed', senderId: 'departed' }, senderType: 'user' },
      { message: { messageId: 'continue', senderId: 'a' }, senderType: 'user' },
    ] as ConversationInput[] });
    for (let turn = 0; turn < 2; turn++) {
      const operation = await f.gate.enter(request, 'chat');
      expect(operation.executionScope).toBe(original.executionScope);
      await f.gate.run(operation, async () => {
        const result = await fetchSpaceFreshnessHistory(f.gate, input, history);
        expect(result.inputs.map(entry => entry.message.messageId)).toEqual(['continue']);
        await expect(f.gate.deliver('chat', async () => 'sent')).resolves.toBe('sent');
      });
      expect(f.authorization.inspect(original.context).binding.version).toBe(1);
    }
  } finally { await f.services.close(); await rm(root, { recursive: true, force: true }); }
});
