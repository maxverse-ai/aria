import { createLarkChannel, normalize, type NormalizedMessage } from '@larksuite/channel';
import { afterEach, expect, it } from 'vitest';
import { LarkSdkCache } from '../../../src/bot/lark-sdk-cache';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function channel(name: string, cache?: LarkSdkCache) {
  const hits: string[] = [];
  const sdk = createLarkChannel({ appId: `fixture_${name}`, appSecret: 'fixture',
    cache, policy: { requireMention: false }, safety: { chatQueue: { enabled: false } },
    logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} },
  });
  sdk.on({ message: async msg => { hits.push(msg.messageId); } });
  // Exercise the real SDK pipeline without opening a network connection.
  const pipeline = (sdk as unknown as { safety: { pushMessage(msg: NormalizedMessage): Promise<void>; dispose(): Promise<void> } }).safety;
  cleanup.push(async () => { await sdk.disconnect(); await pipeline.dispose(); cache?.close(); });
  return { hits, push: (msg: NormalizedMessage) => pipeline.pushMessage(msg), sdk };
}
async function message(id: string) {
  return normalize({ sender: { sender_id: { open_id: 'human' }, sender_type: 'user' },
    message: { message_id: id, chat_id: 'chat', chat_type: 'group', message_type: 'text',
      create_time: String(Date.now()), content: JSON.stringify({ text: 'count' }), mentions: [] },
  }, { botIdentity: { openId: 'fixture', name: 'fixture' } });
}
it('reproduces the SDK default cross-channel deduplication', async () => {
  const a = channel('a'), b = channel('b');
  const msg = await message('default-cache-regression');
  await a.push(msg); await tick(); await b.push(msg); await tick();
  expect(a.hits).toHaveLength(1); expect(b.hits).toHaveLength(0);
});
it.each([false, true])('delivers once per participant, sequential/concurrent=%s', async concurrent => {
  const peers = ['Jack', 'Alice', 'CoCo'].map(name => channel(name, new LarkSdkCache()));
  const msg = await message(`isolated-${concurrent}`);
  if (concurrent) await Promise.all(peers.flatMap(p => [p.push(msg), p.push(msg)]));
  else for (const peer of peers) { await peer.push(msg); await tick(); }
  await tick();
  for (const peer of peers) { await peer.push(msg); await tick(); expect(peer.hits).toEqual([msg.messageId]); }
});
it('a skipped consumer and a closed peer do not consume another account delivery', async () => {
  const cache = new LarkSdkCache();
  const a = channel('a', cache), b = channel('b', new LarkSdkCache());
  a.sdk.on({ message: async () => {} }); // Aria no-mention skip
  const msg = await message('skipped');
  await a.push(msg); await tick(); await a.sdk.disconnect(); cache.close();
  await b.push(msg); await tick();
  expect(b.hits).toEqual(['skipped']);
});
it('native transport reconnect preserves deduplication for the same channel', async () => {
  const peer = channel('reconnect', new LarkSdkCache());
  const msg = await message('reconnect');
  await peer.push(msg); await tick();
  // Stub only the network handshake; run the SDK's real reconnect method.
  Object.assign(peer.sdk, { connectWebSocket: async () => {} });
  await (peer.sdk as unknown as { forceReconnect(): Promise<void> }).forceReconnect();
  await peer.push(msg); await tick();
  expect(peer.hits).toEqual(['reconnect']);
});
