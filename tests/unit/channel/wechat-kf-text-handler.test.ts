import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProfileConversationHost } from '../../../src/conversation/profile-host';
import { FileWechatKfOnboardingStore } from '../../../src/channel/wechat-kf/onboarding-store';
import { FileWechatKfReceiptStore } from '../../../src/channel/wechat-kf/receipt-store';
import { FileWechatKfDeliveryStore } from '../../../src/channel/wechat-kf/delivery-store';
import { WechatKfTextHandler } from '../../../src/channel/wechat-kf/text-handler';
import { WechatKfMediaError } from '../../../src/channel/wechat-kf/client';
import { createDefaultWechatKfPresentation } from '../../../src/channel/wechat-kf/presentation';
import type { WechatKfMessage } from '../../../src/channel/wechat-kf/types';
import { FileAttachmentStore } from '../../../src/media/file-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('WechatKfTextHandler', () => {
  it('preserves the legacy text-only host contract when run is unavailable', async () => {
    const harness = await createHarness();
    delete (harness.host as Partial<typeof harness.host>).run;

    await harness.handler.accept(message('m-legacy-text', '你好'));

    expect(harness.host.runText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '你好',
    }));
  });

  it('downloads and persists an inbound image before passing it to the agent', async () => {
    const harness = await createHarness();

    await harness.handler.accept(imageMessage('m-inbound-image', 'media-inbound-1'));

    expect(harness.api.downloadImage).toHaveBeenCalledWith({ mediaId: 'media-inbound-1' });
    expect(harness.host.runText).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining('图片'),
      attachments: [expect.objectContaining({
        kind: 'image',
        decision: 'accepted',
        requiredness: 'required',
        path: expect.stringMatching(/\.png$/),
        hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      })],
    }));
    const attachmentPath = harness.host.runText.mock.calls[0]?.[0].attachments[0].path;
    await expect(readFile(attachmentPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finishes an invalid inbound image with a user-visible answer without starting the agent', async () => {
    const harness = await createHarness();
    harness.api.downloadImage.mockRejectedValueOnce(
      new WechatKfMediaError('invalid-image', 'not an image'),
    );

    await harness.handler.accept(imageMessage('m-invalid-image', 'media-invalid'));

    expect(harness.host.runText).not.toHaveBeenCalled();
    expect(harness.api.sendText.mock.calls.at(-1)?.[0].content).toContain('JPG 或 PNG');
  });

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
    expect(harness.api.sendText.mock.calls[0]?.[0].content).toContain('产品助手');
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
    expect(harness.api.sendText.mock.calls[2]?.[0].content).toContain('产品助手');
  });

  it('uses injected product copy for onboarding and help without changing commands', async () => {
    const userCopy = {
      welcomeIntroduction: '你好，我是 Example 产品助手。',
      helpTitle: 'Example 产品助手',
      helpPrompt: '直接发送 Example 产品问题即可。',
    };
    const onboardingHarness = await createHarness({ userCopy });
    await onboardingHarness.handler.accept(message('m-branded-question', '普通问题'));
    expect(onboardingHarness.api.sendText.mock.calls[0]?.[0].content).toContain(
      userCopy.welcomeIntroduction,
    );

    const helpHarness = await createHarness({ userCopy });
    await helpHarness.handler.accept(message('m-branded-help', '/help'));
    const help = helpHarness.api.sendText.mock.calls[0]?.[0].content;
    expect(help).toContain(userCopy.helpTitle);
    expect(help).toContain(userCopy.helpPrompt);
    expect(help).toContain('/new：归档当前上下文并开启新会话');
  });

  it('resolves one deployment-owned presentation for each new inbound message', async () => {
    const fallback = createDefaultWechatKfPresentation();
    const resolve = vi.fn(({ message: input }: { message: { kind: string; text?: string } }) => ({
      ...fallback,
      welcome: 'Welcome. Ask a product question.',
      help: 'Product assistant\nAsk a product question.\n\n/help: Show help',
      processing: 'Looking up the relevant information. Please wait.',
      imageLabel: 'Image',
      ...(input.kind === 'text' && input.text === '/help'
        ? { help: 'English help' }
        : {}),
    }));
    const begin = vi.fn(() => ({
      beforeFinal: vi.fn().mockResolvedValue(undefined),
      finish: vi.fn().mockResolvedValue(undefined),
    }));
    const harness = await createHarness({
      presentation: { resolve },
      processingFeedback: { begin },
    });

    await harness.handler.accept(message('m-presented-question', 'How do I configure it?'));

    expect(resolve).toHaveBeenCalledOnce();
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      message: { kind: 'text', text: 'How do I configure it?' },
    }));
    expect(harness.api.sendText.mock.calls[0]?.[0].content).toBe(
      'Welcome. Ask a product question.',
    );
    expect(begin).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Looking up the relevant information. Please wait.',
    }));
  });

  it('routes new, stop, and unknown commands deterministically', async () => {
    const processingFeedback = {
      begin: vi.fn(() => ({
        beforeFinal: vi.fn().mockResolvedValue(undefined),
        finish: vi.fn().mockResolvedValue(undefined),
      })),
    };
    const harness = await createHarness({ processingFeedback });
    harness.host.interrupt.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await harness.handler.accept(message('m-new', '/reset'));
    await harness.handler.accept(message('m-stop', '/stop'));
    await harness.handler.accept(message('m-idle', '/cancel'));
    await harness.handler.accept(message('m-unknown', '/sync'));

    expect(harness.host.reset).toHaveBeenCalledOnce();
    expect(harness.host.interrupt).toHaveBeenCalledTimes(2);
    expect(harness.host.runText).not.toHaveBeenCalled();
    expect(processingFeedback.begin).not.toHaveBeenCalled();
    expect(harness.api.sendText.mock.calls.map((call) => call[0].content)).toEqual([
      '已开启新会话，你可以开始提问。',
      '已停止当前查询。',
      '当前没有正在查询的内容。',
      '不支持该命令，请发送 /help。',
    ]);
  });

  it('settles ordinary-message feedback before sending the final answer', async () => {
    const events: string[] = [];
    let inspectCheckpoint = async () => {};
    const processingFeedback = {
      begin: vi.fn(() => ({
        async beforeFinal() {
          events.push('before-final');
          await inspectCheckpoint();
        },
        async finish() { events.push('finish'); },
      })),
    };
    const harness = await createHarness({ processingFeedback });
    inspectCheckpoint = async () => {
      expect(await harness.deliveries.get('m-feedback')).toMatchObject({
        chunks: [{ content: '查询结果' }],
      });
    };
    harness.host.runText.mockImplementationOnce(async () => {
      events.push('run');
      return { ok: true, runId: 'run-feedback', content: '查询结果' };
    });
    harness.api.sendText.mockImplementation(async (input: { content: string }) => {
      if (input.content === '查询结果') events.push('answer');
      return { messageId: 'sent' };
    });

    await harness.handler.accept(message('m-feedback', '普通问题'));

    expect(processingFeedback.begin).toHaveBeenCalledWith({
      externalUserId: 'wm_user',
      openKfid: 'wk123',
      inboundMessageId: 'm-feedback',
      content: '正在为你查询相关信息，请稍等。',
    });
    expect(events).toEqual(['run', 'before-final', 'answer', 'finish']);
  });

  it('renders markdown to plain text before splitting and sending an answer', async () => {
    const harness = await createHarness();
    harness.host.runText.mockResolvedValueOnce({
      ok: true,
      runId: 'run-markdown',
      content: '## HDR 支持情况\n\n- **S3 5.2**：支持 HDR',
    });

    await harness.handler.accept(message('m-markdown', 'S3 支持 HDR 吗？'));

    expect(harness.api.sendText.mock.calls.at(-1)?.[0].content).toBe(
      'HDR 支持情况\n\n• S3 5.2：支持 HDR',
    );
  });

  it('renders the complete answer before applying the byte limit', async () => {
    const harness = await createHarness();
    harness.host.runText.mockResolvedValueOnce({
      ok: true,
      runId: 'run-long-markdown',
      content: `**${'中'.repeat(900)}**`,
    });

    await harness.handler.accept(message('m-long-markdown', '请详细说明'));

    const answerChunks = harness.api.sendText.mock.calls.slice(1).map((call) => call[0].content);
    expect(answerChunks).toHaveLength(2);
    expect(answerChunks.join('')).toBe('中'.repeat(900));
    expect(answerChunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 2048)).toBe(true);
  });

  it('settles feedback when an ordinary run is interrupted without sending an answer', async () => {
    const beforeFinal = vi.fn().mockResolvedValue(undefined);
    const finish = vi.fn().mockResolvedValue(undefined);
    const harness = await createHarness({
      processingFeedback: { begin: vi.fn(() => ({ beforeFinal, finish })) },
    });
    harness.host.runText.mockResolvedValueOnce({
      ok: false,
      runId: 'run-interrupted',
      code: 'run-interrupted',
      userVisible: 'interrupted',
    });

    await harness.handler.accept(message('m-interrupted', '普通问题'));

    expect(beforeFinal).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
    expect(harness.api.sendText.mock.calls.map((call) => call[0].content)).not.toContain('interrupted');
  });

  it('finishes ordinary-message feedback when the run fails', async () => {
    const beforeFinal = vi.fn().mockResolvedValue(undefined);
    const finish = vi.fn().mockResolvedValue(undefined);
    const harness = await createHarness({
      processingFeedback: { begin: vi.fn(() => ({ beforeFinal, finish })) },
    });
    harness.host.runText.mockRejectedValueOnce(new Error('agent failed'));

    await expect(harness.handler.accept(message('m-failed', '普通问题')))
      .rejects.toThrow('agent failed');

    expect(beforeFinal).not.toHaveBeenCalled();
    expect(finish).toHaveBeenCalledOnce();
  });

  it('retries a failed final delivery without rerunning the agent', async () => {
    const harness = await createHarness();
    const input = message('m-delivery-retry', '普通问题');
    harness.api.sendText
      .mockResolvedValueOnce({ messageId: 'welcome' })
      .mockRejectedValueOnce(new Error('send unavailable'))
      .mockResolvedValueOnce({ messageId: 'answer' });

    await expect(harness.handler.accept(input)).rejects.toThrow('send unavailable');
    expect(harness.host.runText).toHaveBeenCalledOnce();
    expect(await harness.deliveries.get(input.msgid)).toMatchObject({
      chunks: [{ content: '查询结果' }],
    });

    await harness.handler.accept(input);
    expect(harness.host.runText).toHaveBeenCalledOnce();
    expect(harness.api.sendText.mock.calls.map((call) => call[0].content)).toEqual([
      expect.stringContaining('产品助手'),
      '查询结果',
      '查询结果',
    ]);
    expect(await harness.deliveries.get(input.msgid)).toBeUndefined();
  });

  it('delivers a deployment-composed text and image answer in order', async () => {
    const answerComposer = vi.fn().mockResolvedValue([
      { kind: 'text', content: '**产品示意图**' },
      { kind: 'image', assetRef: 'kb-asset://approved/product-image' },
    ]);
    const imageMaterializer = vi.fn().mockResolvedValue({
      mediaId: 'approved-media-id',
      expiresAt: 10_000,
    });
    const harness = await createHarness({ answerComposer, imageMaterializer, now: () => 1_000 });

    await harness.handler.accept(message('m-image-answer', '请发产品示意图'));

    expect(answerComposer).toHaveBeenCalledWith({ content: '查询结果' });
    expect(imageMaterializer).toHaveBeenCalledWith({
      assetRef: 'kb-asset://approved/product-image',
    });
    expect(harness.api.sendText.mock.calls.at(-1)?.[0].content).toBe('产品示意图');
    expect(harness.api.sendImage).toHaveBeenCalledWith({
      externalUserId: 'wm_user',
      openKfid: 'wk123',
      mediaId: 'approved-media-id',
      messageId: expect.stringMatching(/^[0-9A-Za-z_-]{32}$/),
    });
  });

  it('resumes an undelivered image without rerunning or recomposing the answer', async () => {
    const answerComposer = vi.fn().mockResolvedValue([
      { kind: 'text', content: '说明' },
      { kind: 'image', assetRef: 'kb-asset://approved/product-image' },
    ]);
    const imageMaterializer = vi.fn().mockResolvedValue({
      mediaId: 'approved-media-id',
      expiresAt: 10_000,
    });
    const harness = await createHarness({
      answerComposer,
      imageMaterializer,
      now: () => 1_000,
    });
    harness.api.sendImage
      .mockRejectedValueOnce(new Error('image unavailable'))
      .mockResolvedValueOnce({ messageId: 'image-sent' });
    const input = message('m-image-retry', '请发产品示意图');

    await expect(harness.handler.accept(input)).rejects.toThrow('image unavailable');
    expect(await harness.deliveries.get(input.msgid)).toMatchObject({
      schemaVersion: 2,
      chunks: [
        { kind: 'text', content: '说明', deliveredAt: expect.any(Number) },
        {
          kind: 'image',
          assetRef: 'kb-asset://approved/product-image',
          mediaId: 'approved-media-id',
          mediaExpiresAt: 10_000,
        },
      ],
    });

    await harness.handler.accept(input);
    expect(harness.host.runText).toHaveBeenCalledOnce();
    expect(answerComposer).toHaveBeenCalledOnce();
    expect(imageMaterializer).toHaveBeenCalledOnce();
    expect(harness.api.sendImage).toHaveBeenCalledTimes(2);
  });

  it('rematerializes an expired image checkpoint before retrying delivery', async () => {
    let now = 1_000;
    const answerComposer = vi.fn().mockResolvedValue([
      { kind: 'image', assetRef: 'kb-asset://approved/product-image' },
    ]);
    const imageMaterializer = vi.fn()
      .mockResolvedValueOnce({ mediaId: 'media-old', expiresAt: 2_000 })
      .mockResolvedValueOnce({ mediaId: 'media-new', expiresAt: 5_000 });
    const harness = await createHarness({
      answerComposer,
      imageMaterializer,
      now: () => now,
    });
    harness.api.sendImage
      .mockRejectedValueOnce(new Error('image unavailable'))
      .mockResolvedValueOnce({ messageId: 'image-sent' });
    const input = message('m-image-expired', '请发产品示意图');

    await expect(harness.handler.accept(input)).rejects.toThrow('image unavailable');
    now = 3_000;
    await harness.handler.accept(input);

    expect(harness.host.runText).toHaveBeenCalledOnce();
    expect(answerComposer).toHaveBeenCalledOnce();
    expect(imageMaterializer).toHaveBeenCalledTimes(2);
    expect(harness.api.sendImage.mock.calls.map((call) => call[0].mediaId)).toEqual([
      'media-old',
      'media-new',
    ]);
  });

  it('falls back to the text answer when deployment composition fails', async () => {
    const onAnswerComposeError = vi.fn();
    const harness = await createHarness({
      answerComposer: vi.fn().mockRejectedValue(new Error('asset policy unavailable')),
      onAnswerComposeError,
    });

    await harness.handler.accept(message('m-image-fallback', '普通问题'));

    expect(onAnswerComposeError).toHaveBeenCalledOnce();
    expect(harness.api.sendText.mock.calls.at(-1)?.[0].content).toBe('查询结果');
    expect(harness.api.sendImage).not.toHaveBeenCalled();
  });

  it('resumes only undelivered answer chunks after a partial send failure', async () => {
    const harness = await createHarness();
    await harness.handler.accept(message('m-onboarding', '准备'));
    harness.host.runText.mockResolvedValueOnce({
      ok: true,
      runId: 'run-long-retry',
      content: '中'.repeat(900),
    });
    harness.api.sendText.mockClear();
    harness.api.sendText
      .mockResolvedValueOnce({ messageId: 'part-0' })
      .mockRejectedValueOnce(new Error('part unavailable'))
      .mockResolvedValueOnce({ messageId: 'part-1' });
    const input = message('m-partial-delivery', '详细回答');

    await expect(harness.handler.accept(input)).rejects.toThrow('part unavailable');
    expect(harness.host.runText).toHaveBeenCalledTimes(2);
    await harness.handler.accept(input);

    expect(harness.host.runText).toHaveBeenCalledTimes(2);
    expect(harness.api.sendText).toHaveBeenCalledTimes(3);
    expect(harness.api.sendText.mock.calls[0]?.[0].content).not.toBe(
      harness.api.sendText.mock.calls[1]?.[0].content,
    );
    expect(harness.api.sendText.mock.calls[2]?.[0]).toEqual(harness.api.sendText.mock.calls[1]?.[0]);
  });
});

async function createHarness(options: {
  onWelcomeError?: (error: unknown) => void;
  onAnswerComposeError?: (error: unknown) => void;
  answerComposer?: import('../../../src/channel/wechat-kf/outbound').WechatKfAnswerComposer;
  imageMaterializer?: import('../../../src/channel/wechat-kf/outbound').WechatKfImageMaterializer;
  processingFeedback?: import('../../../src/channel/wechat-kf/text-handler').WechatKfProcessingFeedback;
  userCopy?: import('../../../src/channel/wechat-kf/commands').WechatKfUserCopy;
  presentation?: import('../../../src/channel/wechat-kf/presentation').WechatKfPresentationProvider;
  now?: () => number;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aria-wxkf-handler-'));
  roots.push(root);
  const onboarding = new FileWechatKfOnboardingStore(join(root, 'onboarding.json'));
  const receipts = new FileWechatKfReceiptStore(join(root, 'receipts.json'));
  const deliveries = new FileWechatKfDeliveryStore(join(root, 'deliveries'));
  await Promise.all([onboarding.load(), receipts.load()]);
  const run = vi.fn().mockResolvedValue({ ok: true, runId: 'run-1', content: '查询结果' });
  const host = {
    run,
    runText: run,
    reset: vi.fn().mockResolvedValue({ interrupted: false, archivedSessionCount: 1 }),
    interrupt: vi.fn().mockResolvedValue(false),
  } as unknown as Pick<ProfileConversationHost, 'run' | 'runText' | 'reset' | 'interrupt'> & {
    run: ReturnType<typeof vi.fn>;
    runText: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
  };
  const api = {
    downloadImage: vi.fn().mockResolvedValue({
      content: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
      contentType: 'image/png' as const,
      filename: 'wechat-image.png',
    }),
    sendText: vi.fn().mockResolvedValue({ messageId: 'sent' }),
    sendImage: vi.fn().mockResolvedValue({ messageId: 'sent-image' }),
  };
  const handler = new WechatKfTextHandler({
    host,
    api,
    sessionHmacSecret: 'test-secret',
    onboarding,
    receipts,
    deliveries,
    attachmentStore: new FileAttachmentStore(join(root, 'attachments')),
    authorized: true,
    ...options,
  });
  return { handler, host, api, deliveries };
}

function imageMessage(msgid: string, mediaId: string): WechatKfMessage {
  return {
    msgid,
    open_kfid: 'wk123',
    external_userid: 'wm_user',
    send_time: 1,
    origin: 3,
    msgtype: 'image',
    image: { media_id: mediaId },
  };
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
