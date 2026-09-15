import { describe, it, expect } from 'vitest';
import { parseCooperativeReply } from '../../../src/conversation/cooperative-reply';
import { PublicationQueue } from '../../../src/conversation/publication-queue';

describe('cooperative terminal protocol', () => {
  it('keeps ordinary replies, quoted examples and waiting prose visible', () => {
    for (const text of ['0', '请稍等', '示例 <aria_reply>{"action":"wait"}</aria_reply>']) {
      expect(parseCooperativeReply(text)).toEqual({ action: 'reply', text });
    }
  });
  it('recognizes an exact wait and a structured handoff', () => {
    expect(parseCooperativeReply(' <aria_reply>{"action":"wait"}</aria_reply> ')).toEqual({ action: 'wait' });
    expect(parseCooperativeReply('<aria_reply>{"action":"handoff","recipient":"peer:alice","text":"0"}</aria_reply>'))
      .toEqual({ action: 'handoff', recipient: 'peer:alice', text: '0' });
  });
  it.each(['{}', 'null', '{"action":"wait","text":"oops"}', '{"action":"handoff","recipient":"<at>","text":"0"}',
    '{"action":"handoff","recipient":"peer","text":" "}'])('rejects invalid payload %s', value => {
    expect(parseCooperativeReply(`<aria_reply>${value}</aria_reply>`)).toEqual({ action: 'invalid' });
  });
});

describe('host publication queue', () => {
  it('serializes same-conversation check and publish but permits other scopes', async () => {
    const queue = new PublicationQueue();
    const events: string[] = [];
    let release!: () => void;
    const first = queue.run('group', async () => {
      events.push('check-a');
      await new Promise<void>(resolve => { release = resolve; });
      events.push('send-a');
    });
    const second = queue.run('group', async () => { events.push('check-b'); events.push('send-b'); });
    await queue.run('other', async () => { events.push('other'); });
    expect(events).toEqual(['check-a', 'other']);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['check-a', 'other', 'send-a', 'check-b', 'send-b']);
  });
  it('releases ownership even after a failed publisher', async () => {
    const queue = new PublicationQueue();
    await expect(queue.run('group', async () => { throw Error('failed'); })).rejects.toThrow('failed');
    await expect(queue.run('group', async () => 'next')).resolves.toBe('next');
  });
});
