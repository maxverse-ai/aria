import { describe, expect, it } from 'vitest';
import { normalize, type RawMessageEvent } from '@larksuite/channel';
import { isSelfMentionPing, messageCommandText, normalizeMessage, preserveMessageMentions } from '../../../src/bot/message-normalization';

const names = ['CoCo', 'Alice', 'Jack'];
const mentions = names.map((name, i) => ({ key: `@_user_${i + 1}`, id: { open_id: `ou_${name}` }, name }));
function raw(text: string, type: 'text' | 'post' = 'text'): RawMessageEvent {
  const content = type === 'text' ? { text } : { zh_cn: { title: '', content: [text.split(/(@_user_[123])/).filter(Boolean).map(part => {
    const mention = mentions.find(m => m.key === part);
    return mention ? { tag: 'at', user_id: mention.id.open_id } : { tag: 'text', text: part };
  })] } };
  return { sender: { sender_id: { open_id: 'ou_human' }, sender_type: 'user' }, message: {
    message_id: 'om_fixture', chat_id: 'oc_fixture', chat_type: 'group', message_type: type,
    content: JSON.stringify(content), mentions,
  } };
}
async function receive(event: RawMessageEvent, name = 'Jack') {
  return normalize(event, { botIdentity: { openId: `ou_${name}`, name }, stripBotMentions: true, includeRaw: true });
}
for (const type of ['text', 'post'] as const) {
  describe(type, () => {
    it.each(names)('restores the same counting request for %s while retaining authoritative metadata', async name => {
      const event = raw('@_user_1 @_user_2 @_user_3 从 0 开始轮流数，每次加 1，数到 8。', type);
      const before = JSON.stringify(event);
      const received = await receive(event, name);
      expect(received.content).not.toContain(`@${name}`);
      const restored = await preserveMessageMentions(received);
      expect(restored.content).toBe('@CoCo @Alice @Jack 从 0 开始轮流数，每次加 1，数到 8。');
      expect({ ...restored, content: '' }).toEqual({ ...received, content: '' });
      expect(restored.mentions).toBe(received.mentions);
      expect(restored.resources).toBe(received.resources);
      expect(JSON.stringify(event)).toBe(before);
      const history = await normalizeMessage(event, { botIdentity: { openId: `ou_${name}`, name } });
      expect(history.content).toBe(restored.content);
    });
    it('preserves repeated mentions, their positions and negative instructions', async () => {
      const event = raw('@_user_2 检查 @_user_3 的结果；@_user_3 不要回答，先等 @_user_1。', type);
      expect((await preserveMessageMentions(await receive(event))).content)
        .toBe('@Alice 检查 @Jack 的结果；@Jack 不要回答，先等 @CoCo。');
    });
    it('derives a command without mutating the message, including mentions inside arguments', async () => {
      const event = raw('@_user_3 @_user_3 /help @_user_2', type);
      const restored = await preserveMessageMentions(await receive(event));
      const before = JSON.stringify(restored);
      expect(await messageCommandText(restored)).toBe('/help @Alice');
      expect(JSON.stringify(restored)).toBe(before);
      expect(restored.content).toBe('@Jack @Jack /help @Alice');
    });
    it('retains mention-only content and addressing with an empty command projection', async () => {
      const restored = await preserveMessageMentions(await receive(raw('@_user_3', type)));
      expect(restored.content).toBe('@Jack');
      expect(restored.mentionedBot).toBe(true);
      expect(await messageCommandText(restored)).toBe('');
      expect(isSelfMentionPing(restored)).toBe(true);
    });
    it.each(['@Jack /help', '@_user_2 @_user_3 /help', '请解释 @_user_3 /help'])('does not turn %s into an executable command', async text => {
      const restored = await preserveMessageMentions(await receive(raw(text, type)));
      expect(await messageCommandText(restored)).not.toMatch(/^\//);
    });
  });
}
it('does not invent content when the raw event is unavailable or belongs to another message', async () => {
  const received = await receive(raw('@_user_3 hello'));
  const absent = { ...received, raw: undefined };
  expect(await preserveMessageMentions(absent)).toBe(absent);
  const wrong = { ...received, messageId: 'other' };
  expect(await preserveMessageMentions(wrong)).toBe(wrong);
});
it('retains rich-text resources and the original raw event', async () => {
  const event = raw('@_user_3 检查图片', 'post');
  const body = JSON.parse(event.message.content);
  body.zh_cn.content[0].push({ tag: 'img', image_key: 'img_fixture' });
  event.message.content = JSON.stringify(body);
  const received = await receive(event);
  const restored = await preserveMessageMentions(received);
  expect(restored.content).toContain('@Jack'); expect(restored.content).toContain('img_fixture');
  expect(restored.resources).toBe(received.resources); expect(restored.raw).toBe(received.raw);
});
it('does not re-expand cards or forwarded trees', async () => {
  const received = await receive(raw('hello'));
  for (const type of ['interactive', 'merge_forward']) {
    const message = { ...received, raw: { ...(received.raw as RawMessageEvent), message: { ...(received.raw as RawMessageEvent).message, message_type: type } } };
    expect(await preserveMessageMentions(message)).toBe(message);
  }
});

for (const type of ['text', 'post'] as const) {
  it.each(['/help @_user_3', '@_user_3 /help @_user_3'])(`${type}: supports trailing invocation without changing canonical text: %s`, async text => {
    const restored = await preserveMessageMentions(await receive(raw(text, type)));
    const before = JSON.stringify(restored);
    expect(await messageCommandText(restored)).toBe('/help');
    expect(JSON.stringify(restored)).toBe(before);
  });
  it.each(['@Jack', '@_user_2 @_user_3', '@_user_3 等等', '结果交给 @_user_3。'])(`${type}: does not classify substantive text as a ping: %s`, async text => {
    const restored = await preserveMessageMentions(await receive(raw(text, type)));
    expect(isSelfMentionPing(restored)).toBe(false);
  });
}
it('falls back to the SDK body on malformed raw JSON', async () => {
  const received = await receive(raw('@_user_3 hello'));
  (received.raw as RawMessageEvent).message.content = '{broken';
  expect(await preserveMessageMentions(received)).toBe(received);
  expect(await messageCommandText(received)).toBe('hello');
  expect(isSelfMentionPing(received)).toBe(false);
});
it('does not re-render messages without self mentions', async () => {
  const received = await receive(raw('hello'));
  received.mentions = [];
  expect(await preserveMessageMentions(received)).toBe(received);
});
