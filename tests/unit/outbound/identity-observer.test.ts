import type { LarkChannel, NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OutboundIdentityObserver,
  senderIdentityFromMessage,
} from '../../../src/outbound/identity-observer.js';

afterEach(() => vi.useRealTimers());

describe('outbound identity observer', () => {
  it('normalizes raw Feishu sender identifiers for policy audit events', () => {
    const message = {
      senderId: 'ou_fallback',
      raw: {
        sender: {
          tenant_key: 'tenant_1',
          sender_id: {
            open_id: 'ou_raw',
            user_id: 'user_1',
            union_id: 'union_1',
          },
        },
      },
    } as unknown as NormalizedMessage;

    expect(senderIdentityFromMessage(message, 'cli_app')).toEqual({
      appId: 'cli_app',
      tenantKey: 'tenant_1',
      openId: 'ou_raw',
      userId: 'user_1',
      unionId: 'union_1',
    });
  });

  it('falls back to the normalized sender open_id', () => {
    const message = { senderId: 'ou_fallback' } as unknown as NormalizedMessage;
    expect(senderIdentityFromMessage(message, 'cli_app')).toEqual({
      appId: 'cli_app',
      openId: 'ou_fallback',
    });
  });

  it('emits a resolved group identity and suppresses refreshes within the cache window', async () => {
    const getChatInfo = vi.fn().mockResolvedValue({ name: 'Render Team', ownerId: 'ou_owner' });
    const getChatMembers = vi.fn().mockResolvedValue([{ id: 'ou_owner', name: 'Owner' }]);
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const observer = new OutboundIdentityObserver(
      { getChatInfo, getChatMembers } as unknown as LarkChannel,
      'cli_app',
      (event, fields) => events.push({ event, fields }),
      () => 10_000_000,
    );

    observer.observeMessage(groupMessage());
    await vi.waitFor(() => expect(events.some(({ event }) => event === 'group-resolved')).toBe(true));
    observer.observeMessage(groupMessage());

    expect(getChatInfo).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      event: 'group-resolved',
      fields: {
        chatId: 'oc_group',
        chatType: 'group',
        chatName: 'Render Team',
        ownerOpenId: 'ou_owner',
        ownerName: 'Owner',
      },
    });
  });

  it('times out a hung lookup, clears in-flight state, and retries after backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    let resolveFirst!: (value: { name: string; ownerId: string }) => void;
    const first = new Promise<{ name: string; ownerId: string }>((resolve) => {
      resolveFirst = resolve;
    });
    const getChatInfo = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({ name: 'Recovered Group', ownerId: 'ou_owner' });
    const getChatMembers = vi.fn().mockResolvedValue([{ id: 'ou_owner', name: 'Owner' }]);
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const observer = new OutboundIdentityObserver(
      { getChatInfo, getChatMembers } as unknown as LarkChannel,
      'cli_app',
      (event, fields) => events.push({ event, fields }),
      Date.now,
      { resolveTimeoutMs: 100, retryBaseMs: 200, retryMaxMs: 1_000 },
    );

    observer.observeMessage(groupMessage());
    await vi.advanceTimersByTimeAsync(100);
    expect(events.find(({ event }) => event === 'group-resolve-failed')?.fields).toEqual(
      expect.objectContaining({ errorCode: 'TIMEOUT', retryInMs: 200 }),
    );

    observer.observeMessage(groupMessage());
    expect(getChatInfo).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    observer.observeMessage(groupMessage());
    await vi.waitFor(
      () => expect(events.some(({ event }) => event === 'group-resolved')).toBe(true),
      { interval: 1, timeout: 50 },
    );
    expect(getChatInfo).toHaveBeenCalledTimes(2);
    expect(events.find(({ event }) => event === 'group-resolved')?.fields).toEqual(
      expect.objectContaining({ chatName: 'Recovered Group', ownerName: 'Owner' }),
    );

    resolveFirst({ name: 'Late Group', ownerId: 'ou_late' });
    await Promise.resolve();
    expect(getChatMembers).toHaveBeenCalledTimes(1);
    expect(events.some(({ event, fields }) => event === 'group-resolved' && fields.chatName === 'Late Group')).toBe(false);
  });

  it('backs off rejected lookups and emits a stable failure code', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000_000);
    const getChatInfo = vi.fn().mockRejectedValue(new Error('upstream unavailable\ntry later'));
    const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const observer = new OutboundIdentityObserver(
      { getChatInfo } as unknown as LarkChannel,
      'cli_app',
      (event, fields) => events.push({ event, fields }),
      Date.now,
      { resolveTimeoutMs: 100, retryBaseMs: 200, retryMaxMs: 1_000 },
    );

    observer.observeMessage(groupMessage());
    await vi.waitFor(
      () => expect(events.some(({ event }) => event === 'group-resolve-failed')).toBe(true),
      { interval: 1, timeout: 50 },
    );

    expect(events.find(({ event }) => event === 'group-resolve-failed')?.fields).toEqual({
      chatId: 'oc_group',
      attempt: 1,
      errorCode: 'LOOKUP_FAILED',
      retryInMs: 200,
      error: 'upstream unavailable try later',
    });
  });
});

function groupMessage(): NormalizedMessage {
  return {
    senderId: 'ou_sender',
    chatId: 'oc_group',
    chatType: 'group',
  } as unknown as NormalizedMessage;
}
