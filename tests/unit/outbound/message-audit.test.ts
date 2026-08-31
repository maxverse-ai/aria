import { describe, expect, it } from 'vitest';
import { OutboundBroker } from '../../../src/outbound/broker';
import type { MessageAuditEvent } from '../../../src/runtime/message-audit';

const envelope = {
  sink: 'message.send' as const, intent: 'agent.final' as const,
  context: { profile: '***REMOVED***', source: 'im' as const, conversationId: 'scope-secret', operationId: 'op-secret' },
  payload: { to: 'chat-secret', input: { text: 'private response' } },
};

describe('OutboundBroker message audit', () => {
  it('records only after a successful send and excludes payload content', async () => {
    const events: MessageAuditEvent[] = [];
    const messages: unknown[] = [];
    const broker = new OutboundBroker({
      messageAudit: { record: async (event) => { events.push(event); } },
      messageRead: {
        observe: async (event) => { messages.push(event); },
        bind: async () => undefined,
        remove: async () => undefined,
      },
      now: () => new Date('2026-08-27T00:00:00.000Z'),
    });
    await expect(broker.dispatch(envelope, async () => ({ messageId: 'om_reply' }))).resolves.toEqual({ messageId: 'om_reply' });
    expect(events).toEqual([expect.objectContaining({ direction: 'outbound', conversationKey: 'scope-secret' })]);
    expect(messages).toEqual([expect.objectContaining({
      sourceMessageId: 'om_reply', correlationId: 'op-secret', actorKind: 'bot',
    })]);
    expect(JSON.stringify(events)).not.toContain('private response');
    expect(JSON.stringify(events)).not.toContain('chat-secret');
  });

  it('does not claim a failed send and isolates audit storage failures', async () => {
    const events: MessageAuditEvent[] = [];
    const broker = new OutboundBroker({ messageAudit: { record: async (event) => { events.push(event); } } });
    await expect(broker.dispatch(envelope, async () => { throw new Error('send failed'); })).rejects.toThrow('send failed');
    expect(events).toEqual([]);

    const degraded = new OutboundBroker({ messageAudit: { record: async () => { throw new Error('audit failed'); } } });
    await expect(degraded.dispatch(envelope, async () => 'sent')).resolves.toBe('sent');
  });

  it('keeps separate receipts for repeated sends and records completed streams', async () => {
    const events: MessageAuditEvent[] = [];
    const messages: Array<{ sourceMessageId: string; content: { format: string } }> = [];
    const broker = new OutboundBroker({
      messageAudit: { record: async (event) => { events.push(event); } },
      messageRead: {
        observe: async (event) => { messages.push(event); },
        bind: async () => undefined,
        remove: async () => undefined,
      },
    });
    await broker.dispatch(envelope, async () => ({ messageId: 'om_first' }));
    await broker.dispatch(envelope, async () => ({ messageId: 'om_second' }));
    await broker.dispatch({
      ...envelope,
      sink: 'message.stream',
      payload: { to: 'chat-secret', input: { markdown: async () => undefined } },
    }, async () => ({ messageId: 'om_stream' }));

    expect(events.map((event) => event.eventId)).toEqual([
      'outbound:om_first', 'outbound:om_second', 'outbound:om_stream',
    ]);
    expect(messages.map((message) => message.sourceMessageId)).toEqual([
      'om_first', 'om_second', 'om_stream',
    ]);
    expect(messages[2]?.content.format).toBe('unavailable');
  });
});
