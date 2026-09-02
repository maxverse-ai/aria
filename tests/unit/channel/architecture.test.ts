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

  it('routes the existing Lark message run through ConversationRuntime', async () => {
    const source = await readFile('src/bot/channel.ts', 'utf8');
    expect(source).toContain('const conversations = new ConversationRuntime({');
    expect(source).toContain('const flow = await conversations.start({');
    expect(source).toContain('conversations.recordEvent({');
  });

  it('does not cut production Supervisor startup over to the Stage 1 registry', async () => {
    const source = await readFile('src/runtime/supervisor.ts', 'utf8');
    expect(source).not.toContain('ChannelPluginRegistry');
    expect(source).not.toContain("channel/plugin/registry");
  });
});
