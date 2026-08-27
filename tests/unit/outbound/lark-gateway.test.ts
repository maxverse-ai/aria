import type { LarkChannel } from '@larksuite/channel';
import { describe, expect, it, vi } from 'vitest';
import { OutboundBroker } from '../../../src/outbound/broker.js';
import { withOutboundContext, withOutboundIntent } from '../../../src/outbound/context.js';
import { createLarkOutboundGateway } from '../../../src/outbound/lark-gateway.js';
import type { OutboundEnvelope } from '../../../src/outbound/types.js';

function harness() {
  const comments = {
    reply: vi.fn(async () => undefined),
    fetch: vi.fn(),
  };
  const raw = {
    send: vi.fn(async () => ({ messageId: 'om_sent' })),
    stream: vi.fn(async () => ({ messageId: 'om_stream' })),
    createCard: vi.fn(async () => ({ cardId: 'card_1' })),
    updateCard: vi.fn(async () => undefined),
    updateCardById: vi.fn(async () => undefined),
    comments,
    getChatInfo: vi.fn(async () => ({ chatId: 'oc_chat' })),
  };
  const broker = new OutboundBroker();
  const dispatch = vi.spyOn(broker, 'dispatch');
  const { channel } = createLarkOutboundGateway(raw as unknown as LarkChannel, {
    profile: 'test-profile',
    broker,
  });
  const envelopes = (): OutboundEnvelope[] => dispatch.mock.calls.map(([envelope]) => envelope);
  return { raw, comments, broker, channel, envelopes };
}

describe('Lark outbound gateway', () => {
  it('routes message sends without changing their arguments or result', async () => {
    const h = harness();
    const result = await h.channel.send(
      'oc_chat',
      { markdown: 'hello' },
      { replyTo: 'om_parent', replyInThread: true },
    );

    expect(result).toEqual({ messageId: 'om_sent' });
    expect(h.raw.send).toHaveBeenCalledWith(
      'oc_chat',
      { markdown: 'hello' },
      { replyTo: 'om_parent', replyInThread: true },
    );
    expect(h.envelopes()[0]).toMatchObject({
      sink: 'message.send',
      intent: 'unspecified',
      context: {
        profile: 'test-profile',
        source: 'system',
        conversationId: 'oc_chat',
        sourceMessageId: 'om_parent',
      },
    });
  });

  it('classifies media sends as attachment uploads', async () => {
    const h = harness();
    await h.channel.send('oc_chat', {
      file: { source: '/tmp/report.pdf', fileName: 'report.pdf' },
    });

    expect(h.envelopes()[0]).toMatchObject({
      sink: 'attachment.upload',
      intent: 'attachment.delivery',
    });
  });

  it('routes streams and preserves producer functions', async () => {
    const h = harness();
    const producer = vi.fn(async () => undefined);
    await h.channel.stream('oc_chat', { markdown: producer });

    expect(h.raw.stream).toHaveBeenCalledWith('oc_chat', { markdown: producer }, undefined);
    expect(h.envelopes()[0]).toMatchObject({
      sink: 'message.stream',
      intent: 'agent.progress',
      payload: { input: { markdown: producer } },
    });
  });

  it('routes managed card create and both update forms', async () => {
    const h = harness();
    await h.channel.createCard({ schema: '2.0' });
    await h.channel.updateCard('om_card', { state: 'done' });
    await h.channel.updateCardById('card_1', { state: 'done' }, 3);

    expect(h.envelopes().map((entry) => entry.sink)).toEqual([
      'card.create',
      'card.update',
      'card.update',
    ]);
    expect(h.envelopes()[2]).toMatchObject({
      payload: { target: 'card', cardId: 'card_1', sequence: 3 },
    });
  });

  it('routes comment replies while leaving comment reads directly available', async () => {
    const h = harness();
    const target = { fileToken: 'doc_1', fileType: 'docx' as const };
    await h.channel.comments.reply(target, 'comment_1', 'answer', { topLevel: true });
    await h.channel.comments.fetch(target, 'comment_1');

    expect(h.comments.reply).toHaveBeenCalledWith(
      target,
      'comment_1',
      'answer',
      { topLevel: true },
    );
    expect(h.comments.fetch).toHaveBeenCalledWith(target, 'comment_1');
    expect(h.envelopes()).toHaveLength(1);
    expect(h.envelopes()[0]).toMatchObject({
      sink: 'comment.reply',
      intent: 'agent.final',
    });
  });

  it('carries explicit request context and intent across async work', async () => {
    const h = harness();
    await withOutboundContext(
      {
        profile: 'test-profile',
        source: 'card',
        conversationId: 'oc_chat',
        operationId: 'operation_1',
        sourceMessageId: 'om_card',
        senderOpenId: 'ou_operator',
      },
      () =>
        withOutboundIntent('control.config', async () => {
          await Promise.resolve();
          await h.channel.updateCard('om_card', { state: 'success' });
        }),
    );

    expect(h.envelopes()[0]).toMatchObject({
      sink: 'card.update',
      intent: 'control.config',
      context: {
        profile: 'test-profile',
        source: 'card',
        conversationId: 'oc_chat',
        operationId: 'operation_1',
        sourceMessageId: 'om_card',
        senderOpenId: 'ou_operator',
      },
    });
  });

  it('carries an explicit intent even when no request context is active', async () => {
    const h = harness();
    await withOutboundIntent('control.account', () =>
      h.channel.send('oc_chat', { markdown: 'account updated' }),
    );

    expect(h.envelopes()[0]).toMatchObject({
      sink: 'message.send',
      intent: 'control.account',
      context: {
        profile: 'test-profile',
        source: 'system',
        conversationId: 'oc_chat',
      },
    });
  });

  it('does not proxy reads and rejects sends after the broker closes', async () => {
    const h = harness();
    await h.channel.getChatInfo('oc_chat');
    expect(h.raw.getChatInfo).toHaveBeenCalledWith('oc_chat');
    expect(h.envelopes()).toHaveLength(0);

    h.broker.close();
    await expect(h.channel.send('oc_chat', { text: 'late' })).rejects.toThrow(
      'outbound broker is closed',
    );
    expect(h.raw.send).not.toHaveBeenCalled();
  });
});
