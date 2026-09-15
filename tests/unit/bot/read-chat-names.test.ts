import { afterEach, expect, it, vi } from 'vitest';
import { ReadChatNames } from '../../../src/bot/read-chat-names';

afterEach(() => vi.useRealTimers());
it('deduplicates per-account lookups and keeps last good name through failures', async () => {
  let now = 0;
  const channel = { getChatInfo: vi.fn().mockResolvedValue({ name: '研发群' }) };
  const cache = new ReadChatNames(channel, () => now);
  expect(await Promise.all([cache.get('a'), cache.get('a')])).toEqual(['研发群', '研发群']);
  expect(channel.getChatInfo).toHaveBeenCalledTimes(1);
  now = 300_001; channel.getChatInfo.mockRejectedValue(new Error('unavailable'));
  expect(await cache.get('a')).toBe('研发群');
  expect(await cache.get('a')).toBe('研发群');
  expect(channel.getChatInfo).toHaveBeenCalledTimes(2);
  expect(await new ReadChatNames({ getChatInfo: vi.fn().mockResolvedValue({ name: '另一账号的群' }) }).get('a')).toBe('另一账号的群');
});
it('bounds lookup latency; late results do not overwrite a newer name', async () => {
  vi.useFakeTimers(); let now = 0; let finish!: (value: { name: string }) => void;
  const channel = { getChatInfo: vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ name: '新名称' }) };
  const cache = new ReadChatNames(channel, () => now, 50);
  const first = cache.get('a'); await vi.advanceTimersByTimeAsync(51); expect(await first).toBeUndefined();
  now = 60_001; expect(await cache.get('a')).toBe('新名称');
  finish({ name: '过期名称' }); await Promise.resolve(); expect(await cache.get('a')).toBe('新名称');
});
