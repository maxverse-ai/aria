import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WechatKfDurableMessageSink } from '../../../src/channel/wechat-kf/durable-sink';
import { FileWechatKfMessageInbox } from '../../../src/channel/wechat-kf/message-inbox';
import type { WechatKfMessage } from '../../../src/channel/wechat-kf/types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WechatKfDurableMessageSink', () => {
  it('accepts durably and lets stop bypass a blocked normal user lane', async () => {
    const root = await temporaryRoot();
    const inbox = new FileWechatKfMessageInbox(join(root, 'messages'));
    let releaseNormal!: () => void;
    const normalGate = new Promise<void>((resolve) => { releaseNormal = resolve; });
    const handled: string[] = [];
    const handler = {
      accept: vi.fn(async (input: WechatKfMessage) => {
        if (input.text?.content === 'long query') await normalGate;
        handled.push(input.text?.content ?? '');
      }),
    };
    const sink = new WechatKfDurableMessageSink({
      inbox,
      handler,
      sessionHmacSecret: 'secret',
    });

    await sink.accept(message('m-normal', 'long query', 1));
    expect((await inbox.list()).map((item) => item.msgid)).toEqual(['m-normal']);
    await sink.accept(message('m-stop', '/stop', 2));
    await vi.waitFor(() => expect(handled).toContain('/stop'));
    expect(handled).not.toContain('long query');

    releaseNormal();
    await sink.waitForIdle();
    expect(handled).toEqual(['/stop', 'long query']);
    expect(await inbox.list()).toEqual([]);
  });

  it('recovers queued messages after restart and keeps failed work for another retry', async () => {
    const root = await temporaryRoot();
    const inbox = new FileWechatKfMessageInbox(join(root, 'messages'));
    await inbox.enqueue(message('m-pending', 'pending question', 1));
    const error = vi.fn();
    const failing = new WechatKfDurableMessageSink({
      inbox,
      handler: { accept: vi.fn(async () => { throw new Error('agent failed'); }) },
      sessionHmacSecret: 'secret',
      onProcessingError: error,
    });

    await expect(failing.recover()).resolves.toBe(1);
    await failing.waitForIdle();
    expect(error).toHaveBeenCalledOnce();
    expect((await inbox.list()).map((item) => item.msgid)).toEqual(['m-pending']);

    const handled = vi.fn(async () => undefined);
    const recovered = new WechatKfDurableMessageSink({
      inbox,
      handler: { accept: handled },
      sessionHmacSecret: 'secret',
    });
    await expect(recovered.recover()).resolves.toBe(1);
    await recovered.waitForIdle();
    expect(handled).toHaveBeenCalledOnce();
    expect(await inbox.list()).toEqual([]);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aria-wxkf-durable-sink-'));
  roots.push(root);
  return root;
}

function message(msgid: string, content: string, sendTime: number): WechatKfMessage {
  return {
    msgid,
    open_kfid: 'wk123',
    external_userid: 'wm_user',
    send_time: sendTime,
    origin: 3,
    msgtype: 'text',
    text: { content },
  };
}
