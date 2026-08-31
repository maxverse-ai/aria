import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfileConversationHost } from '../../../src/conversation/profile-host';
import { FileWechatKfOnboardingStore } from '../../../src/channel/wechat-kf/onboarding-store';
import { FileWechatKfReceiptStore } from '../../../src/channel/wechat-kf/receipt-store';
import { WechatKfTextHandler } from '../../../src/channel/wechat-kf/text-handler';
import type { WechatKfMessage } from '../../../src/channel/wechat-kf/types';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WechatKfTextHandler', () => {
  it('handles help without entering the agent and deduplicates webhook replay', async () => {
    const harness = await createHarness();
    const input = message('m-help', '/help');
    await Promise.all([harness.handler.accept(input), harness.handler.accept(input)]);

    expect(harness.host.runText).not.toHaveBeenCalled();
    expect(harness.api.sendText).toHaveBeenCalledTimes(1);
    expect(harness.api.sendText).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('/new'),
      messageId: expect.stringMatching(/^[0-9A-Za-z_-]{32}$/),
    }));
    await harness.handler.accept(input);
    expect(harness.api.sendText).toHaveBeenCalledTimes(1);
  });

  it('sends onboarding once and continues the original question', async () => {
    const harness = await createHarness();
    await harness.handler.accept(message('m-one', 'S3 支持 HDR 吗？'));
    await harness.handler.accept(message('m-two', '5.2 呢？'));

    expect(harness.host.runText).toHaveBeenCalledTimes(2);
    expect(harness.host.runText).toHaveBeenNthCalledWith(1, expect.objectContaining({
      prompt: 'S3 支持 HDR 吗？',
      source: 'channel:wechat-kf',
    }));
    expect(harness.api.sendText).toHaveBeenCalledTimes(3);
    expect(harness.api.sendText.mock.calls[0]?.[0].content).toContain('***REMOVED*** 产品助手');
  });

  it('serializes first help against a concurrent ordinary message without duplicate welcome', async () => {
    const harness = await createHarness();
    let releaseHelp!: () => void;
    const helpGate = new Promise<void>((resolve) => { releaseHelp = resolve; });
    harness.api.sendText.mockImplementation(async (input: { content: string }) => {
      if (input.content.includes('/stop：')) await helpGate;
      return { messageId: 'sent' };
    });

    const help = harness.handler.accept(message('m-help', '/help'));
    await vi.waitFor(() => expect(harness.api.sendText).toHaveBeenCalledOnce());
    const question = harness.handler.accept(message('m-question', '普通问题'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(harness.host.runText).not.toHaveBeenCalled();

    releaseHelp();
    await Promise.all([help, question]);
    expect(harness.host.runText).toHaveBeenCalledOnce();
    expect(harness.api.sendText.mock.calls.map((call) => call[0].content)).toEqual([
      expect.stringContaining('/stop：'),
      '查询结果',
    ]);
  });

  it('does not block the answer when welcome delivery fails and retries later', async () => {
    const warning = vi.fn();
    const harness = await createHarness({ onWelcomeError: warning });
    harness.api.sendText.mockRejectedValueOnce(new Error('welcome failed'));

    await harness.handler.accept(message('m-one', '第一个问题'));
    await harness.handler.accept(message('m-two', '第二个问题'));

    expect(warning).toHaveBeenCalledOnce();
    expect(harness.host.runText).toHaveBeenCalledTimes(2);
    expect(harness.api.sendText).toHaveBeenCalledTimes(4);
    expect(harness.api.sendText.mock.calls[2]?.[0].content).toContain('***REMOVED*** 产品助手');
  });

  it('routes new, stop, and unknown commands deterministically', async () => {
    const harness = await createHarness();
    harness.host.interrupt.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await harness.handler.accept(message('m-new', '/reset'));
    await harness.handler.accept(message('m-stop', '/stop'));
    await harness.handler.accept(message('m-idle', '/cancel'));
    await harness.handler.accept(message('m-unknown', '/sync'));

    expect(harness.host.reset).toHaveBeenCalledOnce();
    expect(harness.host.interrupt).toHaveBeenCalledTimes(2);
    expect(harness.host.runText).not.toHaveBeenCalled();
    expect(harness.api.sendText.mock.calls.map((call) => call[0].content)).toEqual([
      '已开启新会话，你可以开始提问。',
      '已停止当前查询。',
      '当前没有正在查询的内容。',
      '不支持该命令，请发送 /help。',
    ]);
  });
});

async function createHarness(options: { onWelcomeError?: (error: unknown) => void } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aria-wxkf-handler-'));
  roots.push(root);
  const onboarding = new FileWechatKfOnboardingStore(join(root, 'onboarding.json'));
  const receipts = new FileWechatKfReceiptStore(join(root, 'receipts.json'));
  await Promise.all([onboarding.load(), receipts.load()]);
  const host = {
    runText: vi.fn().mockResolvedValue({ ok: true, runId: 'run-1', content: '查询结果' }),
    reset: vi.fn().mockResolvedValue({ interrupted: false, archivedSessionCount: 1 }),
    interrupt: vi.fn().mockResolvedValue(false),
  } as unknown as Pick<ProfileConversationHost, 'runText' | 'reset' | 'interrupt'> & {
    runText: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
  };
  const api = { sendText: vi.fn().mockResolvedValue({ messageId: 'sent' }) };
  const handler = new WechatKfTextHandler({
    host,
    api,
    sessionHmacSecret: 'test-secret',
    onboarding,
    receipts,
    authorized: true,
    ...options,
  });
  return { handler, host, api };
}

function message(msgid: string, content: string): WechatKfMessage {
  return {
    msgid,
    open_kfid: 'wk123',
    external_userid: 'wm_user',
    send_time: 1,
    origin: 3,
    msgtype: 'text',
    text: { content },
  };
}
