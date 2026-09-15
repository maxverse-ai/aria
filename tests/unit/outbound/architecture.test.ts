import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
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

describe('outbound architecture boundary', () => {
  it('constructs the raw Lark channel only in the composition root', async () => {
    const files = await sourceFiles('src');
    const constructors: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (source.includes('createLarkChannel(')) {
        constructors.push(relative('.', file).split(sep).join('/'));
      }
    }

    expect(constructors).toEqual(['src/bot/channel.ts']);
  });

  it('wraps the channel immediately and keeps Meeting on the explicit raw bypass', async () => {
    const source = await readFile('src/bot/channel.ts', 'utf8');
    expect(source).toContain('createLarkOutboundGateway(spaceGate ? spaceLarkChannel(rawChannel, spaceGate) : rawChannel');
    expect(source).toContain('if (spaceGate && controls.profileConfig.meeting.enabled) throw');
    expect(source).toContain('const channel = outboundPolicy?.channel ?? outboundGateway.channel;');
    expect(source).toContain('client: rawChannel.rawClient');
    expect(source).toContain('channel: rawChannel');
  });
});
