import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && path.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat();
}

describe('channel architecture boundary', () => {
  it('keeps core channel and conversation contracts free of Lark SDK types', async () => {
    const files = [
      ...(await sourceFiles('src/channel')),
      ...(await sourceFiles('src/conversation')),
    ];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source, file).not.toContain('@larksuite/channel');
    }
  });

  it('routes Lark through the profile-owned ConversationRuntime', async () => {
    const channel = await readFile('src/bot/channel.ts', 'utf8');
    const supervisor = await readFile('src/runtime/supervisor.ts', 'utf8');
    const externalHost = await readFile('src/conversation/profile-host.ts', 'utf8');

    expect(channel).not.toContain('new ConversationRuntime({');
    expect(externalHost).not.toContain('new ConversationRuntime({');
    expect(supervisor).toContain('new ProfileConversationRuntimeOwner({');
    expect(supervisor).toContain('conversationRuntime: this.conversationRuntime');
    expect(channel).toContain('const conversations = conversationRuntime.runtime;');
    expect(channel).toContain('const flow = await conversations.start({');
    expect(channel).toContain('conversations.recordEvent({');
  });

  it('routes one Lark owner through the bounded rollout composition', async () => {
    const supervisor = await readFile('src/runtime/supervisor.ts', 'utf8');
    const composition = await readFile('src/runtime/lark-channel-runtime.ts', 'utf8');

    expect(supervisor).toContain('projectProfileChannelInstances({');
    expect(supervisor).toContain('requirePrimaryLarkChannelInstance(');
    expect(supervisor).toContain('startProfileLarkChannelRuntime({');
    expect(composition).toContain("options.policy.owner === 'manager'");
    expect(composition).toContain("options.policy.owner === 'legacy'");
    expect(composition).toContain('await manager.start(plans)');
    expect(composition).not.toContain('wechat-kf');
    expect(composition).not.toContain('weixin-ilink');
  });

  it('migrates wechat-kf through its own reliability and lifecycle adapters', async () => {
    const composition = await readFile('src/runtime/wechat-kf-channel-runtime.ts', 'utf8');
    const reliability = await readFile(
      'src/channel/wechat-kf/reliable-message-sink.ts',
      'utf8',
    );
    const ownership = await readFile('src/channel/wechat-kf/ownership.ts', 'utf8');

    expect(composition).toContain("options.policy.owner === 'manager'");
    expect(composition).toContain("options.policy.owner === 'legacy'");
    expect(composition).toContain('await manager.start');
    expect(reliability).toContain('ChannelReliabilityCoordinator');
    expect(reliability).toContain('compatibilityInbox.enqueue');
    expect(reliability).toContain("WECHAT_KF_PLUGIN_ID = 'wechat-kf'");
    expect(ownership).toContain("CURRENT_DEFAULT_WECHAT_KF_CHANNEL_ROLLOUT_MODE = 'shadow'");
    expect(composition).not.toContain('weixin-ilink');
    expect(reliability).not.toContain("pluginId: 'weixin-ilink'");
  });
});
