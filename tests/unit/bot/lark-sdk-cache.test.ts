import { afterEach, expect, it, vi } from 'vitest';
import { LarkSdkCache } from '../../../src/bot/lark-sdk-cache';
afterEach(() => vi.useRealTimers());
it('isolates namespaces, symbols and channel instances', async () => {
  const a = new LarkSdkCache(), b = new LarkSdkCache();
  const key = Symbol('token'), other = Symbol('token');
  await a.set(key, 'token');
  await a.set('m', 'seen', undefined, { namespace: 'events' });
  expect(await a.get(key)).toBe('token');
  expect(await a.get(other)).toBeUndefined();
  expect(await b.get(key)).toBeUndefined();
  expect(await a.get('m')).toBeUndefined();
  expect(await a.get('m', { namespace: 'events' })).toBe('seen');
});
it('honors absolute expiry, replacement and non-expiring SDK entries', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10_000);
  const cache = new LarkSdkCache();
  await cache.set('old', 1, 11_000);
  await cache.set('renew', 1, 11_000);
  await cache.set('renew', 2, 20_000);
  await cache.set('stable', 3);
  vi.setSystemTime(11_000);
  expect(await cache.get('old')).toBeUndefined();
  expect(await cache.get('renew')).toBe(2);
  vi.setSystemTime(100_000);
  await cache.set('next', 4);
  expect(await cache.get('renew')).toBeUndefined();
  expect(await cache.get('stable')).toBe(3);
});
it('closing a channel clears its cache and prevents late writes', async () => {
  const a = new LarkSdkCache(), b = new LarkSdkCache();
  await a.set('m', 1); await b.set('m', 2);
  a.close(); a.close();
  expect(await a.get('m')).toBeUndefined();
  expect(await a.set('m', 3)).toBe(false);
  expect(await b.get('m')).toBe(2);
});
