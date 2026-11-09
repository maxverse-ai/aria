import { describe, expect, it, vi } from 'vitest';
import { LarkChannel, LarkChannelError } from '@larksuite/channel';
import { sendManagedCard, updateManagedCard } from '../../../src/card/managed.js';

describe('managed card sending', () => {
  it('falls back to sending the raw card when the card_id message is rejected', async () => {
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_1' })),
      send: vi.fn()
        .mockRejectedValueOnce(new LarkChannelError('format_error', 'cardid is invalid', {
          context: { attempt: 1 },
        }))
        .mockResolvedValueOnce({ messageId: 'om_raw' }),
    };

    const result = await sendManagedCard(
      channel as never,
      'oc_chat',
      { type: 'template', data: { template_id: 'tpl' } },
      { replyTo: 'om_parent', replyInThread: true },
    );

    expect(result).toEqual({ messageId: 'om_raw', cardId: 'card_1' });
    expect(channel.send).toHaveBeenNthCalledWith(
      1,
      'oc_chat',
      { cardId: 'card_1' },
      { replyTo: 'om_parent', replyInThread: true },
    );
    expect(channel.send).toHaveBeenNthCalledWith(
      2,
      'oc_chat',
      { card: { type: 'template', data: { template_id: 'tpl' } } },
      { replyTo: 'om_parent', replyInThread: true },
    );
  });

  it('updates card-id managed messages by card id', async () => {
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_normal' })),
      send: vi.fn(async () => ({ messageId: 'om_normal' })),
      updateCardById: vi.fn(async () => {}),
      updateCard: vi.fn(async () => {}),
    };

    await sendManagedCard(channel as never, 'oc_chat', { body: 'form' });
    await updateManagedCard(channel as never, 'om_normal', { body: 'cancelled' });

    expect(channel.updateCardById).toHaveBeenCalledWith('card_normal', { body: 'cancelled' }, 1);
    expect(channel.updateCard).not.toHaveBeenCalled();
  });

  it('updates raw-card fallback messages by message id', async () => {
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_raw' })),
      send: vi.fn()
        .mockRejectedValueOnce(new LarkChannelError('format_error', 'cardid is invalid', {
          context: { attempt: 1 },
        }))
        .mockResolvedValueOnce({ messageId: 'om_raw_update' }),
      updateCardById: vi.fn(async () => {}),
      updateCard: vi.fn(async () => {}),
    };

    await sendManagedCard(channel as never, 'oc_chat', { body: 'form' });
    await updateManagedCard(channel as never, 'om_raw_update', { body: 'cancelled' });

    expect(channel.updateCard).toHaveBeenCalledWith('om_raw_update', { body: 'cancelled' });
    expect(channel.updateCardById).not.toHaveBeenCalled();
  });

  it('adopts a card created before restart and keeps updating it by message id', async () => {
    const channel = {
      updateCardById: vi.fn(async () => {}),
      updateCard: vi.fn(async () => {}),
    };

    await updateManagedCard(channel as never, 'om_before_restart', { body: 'loading' });
    await updateManagedCard(channel as never, 'om_before_restart', { body: 'success' });

    expect(channel.updateCard).toHaveBeenNthCalledWith(1, 'om_before_restart', {
      body: 'loading',
    });
    expect(channel.updateCard).toHaveBeenNthCalledWith(2, 'om_before_restart', {
      body: 'success',
    });
    expect(channel.updateCardById).not.toHaveBeenCalled();
  });

  it.each([
    new Error('cardid is invalid'),
    new LarkChannelError('send_timeout', 'timeout'),
    new LarkChannelError('unknown', 'connection closed'),
    new LarkChannelError('format_error', 'cardid is invalid'),
    new LarkChannelError('format_error', 'cardid is invalid', { context: { attempt: 2 } }),
    new LarkChannelError('format_error', 'invalid recipient', { context: { attempt: 1 } }),
    new LarkChannelError('permission_denied', 'cardid is invalid', { context: { attempt: 1 } }),
  ])('does not resend without proof of first-attempt card reference rejection: %s', async (error) => {
    const channel = {
      createCard: vi.fn(async () => ({ cardId: 'card_unknown' })),
      send: vi.fn().mockRejectedValue(error),
    };
    await expect(sendManagedCard(channel as never, 'oc_chat', { schema: '2.0', body: { elements: [] } }))
      .rejects.toBe(error);
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  // Exercise the installed SDK sender/classifier/retry contract. Only the
  // provider API boundary is replaced; no Feishu connection or credentials.
  function providerChannel() {
    const channel = new LarkChannel({
      appId: 'isolated-test', appSecret: 'isolated-test',
      outbound: { retry: { maxAttempts: 2, baseDelayMs: 0 } },
    });
    vi.spyOn(channel.rawClient.cardkit.v1.card, 'create')
      .mockResolvedValue({ data: { card_id: 'card_provider' } });
    return channel;
  }

  it('does not duplicate a remotely accepted message after an SDK timeout', async () => {
    const channel = providerChannel();
    const accepted: unknown[] = [];
    const create = vi.spyOn(channel.rawClient.im.v1.message, 'create').mockImplementation(async (request) => {
      accepted.push(request?.data);
      throw new Error('request timeout after acceptance');
    });
    await expect(sendManagedCard(channel, 'oc_chat', { schema: '2.0', body: { elements: [] } }))
      .rejects.toMatchObject({ code: 'send_timeout', context: { attempt: 1 } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(accepted).toHaveLength(1);
  });

  it('preserves SDK first-attempt format rejection fallback and raw-card updates', async () => {
    const channel = providerChannel();
    const create = vi.spyOn(channel.rawClient.im.v1.message, 'create')
      .mockRejectedValueOnce({ response: { status: 400, data: { msg: 'card_id is invalid' } } })
      .mockResolvedValueOnce({ data: { message_id: 'om_provider_raw' } });
    const patch = vi.spyOn(channel.rawClient.im.v1.message, 'patch').mockResolvedValue({});
    const card = { schema: '2.0', body: { elements: [] } };
    await expect(sendManagedCard(channel, 'oc_chat', card))
      .resolves.toEqual({ messageId: 'om_provider_raw', cardId: 'card_provider' });
    expect(create).toHaveBeenCalledTimes(2);
    expect(JSON.parse(create.mock.calls[0]![0]!.data!.content!)).toEqual({
      type: 'card', data: { card_id: 'card_provider' },
    });
    expect(JSON.parse(create.mock.calls[1]![0]!.data!.content!)).toEqual(card);
    await updateManagedCard(channel, 'om_provider_raw', card);
    expect(patch).toHaveBeenCalledOnce();
  });

  it('does not fallback after an unknown accepted send followed by SDK format rejection', async () => {
    const channel = providerChannel();
    let accepted = 0;
    const create = vi.spyOn(channel.rawClient.im.v1.message, 'create')
      .mockImplementationOnce(async () => {
        accepted += 1;
        throw new Error('socket disconnected after acceptance');
      })
      .mockRejectedValueOnce({ response: { status: 400, data: { msg: 'card_id is invalid' } } });
    await expect(sendManagedCard(channel, 'oc_chat', { schema: '2.0', body: { elements: [] } }))
      .rejects.toMatchObject({ code: 'format_error', context: { attempt: 2 } });
    expect(create).toHaveBeenCalledTimes(2);
    expect(accepted).toBe(1);
  });
});
