import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { nodeVersionNotice } from '../../../src/cli/node-version';

describe('node version deprecation notice', () => {
  it('announces the next required runtime on older ones', () => {
    expect(nodeVersionNotice('22.22.3')).toContain('will require Node 24');
    expect(nodeVersionNotice('22.22.3')).toContain('v22.22.3');
    expect(nodeVersionNotice('20.12.0')).toContain('v20.12.0');
  });

  it('stays silent on supported runtimes', () => {
    for (const version of ['24.0.0', '24.21.0', '26.8.2']) {
      expect(nodeVersionNotice(version)).toBeUndefined();
    }
  });

  it('does not guess when the runtime version is unreadable', () => {
    expect(nodeVersionNotice('')).toBeUndefined();
    expect(nodeVersionNotice('not-a-version')).toBeUndefined();
  });

  it('is wired into the CLI entry so it cannot silently stop appearing', async () => {
    const source = await readFile(new URL('../../../src/cli/index.ts', import.meta.url), 'utf8');
    expect(source).toContain('nodeVersionNotice(process.versions.node)');
  });
});
