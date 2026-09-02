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

  it('runs ChannelManager only as an empty shadow path in Supervisor', async () => {
    const source = await readFile('src/runtime/supervisor.ts', 'utf8');
    expect(source).toContain('new ChannelManager({ profileId: this.profile })');
    expect(source).toContain('await this.channelManager.start([])');
    expect(source).not.toContain('ChannelPluginRegistry');
    expect(source).not.toContain('ResolvedChannelInstance');
  });
});
