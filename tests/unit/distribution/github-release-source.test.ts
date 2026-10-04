import { describe, expect, it, vi } from 'vitest';
import type { CommandRunner } from '../../../src/platform/distribution/command-runner.js';
import { GitHubReleaseSource } from '../../../src/platform/distribution/github-release-source.js';

describe('GitHubReleaseSource', () => {
  it('exposes only complete immutable stable releases', async () => {
    const run = vi.fn<CommandRunner['run']>(async (_command, args) => {
      if (args[0] === 'api' && String(args[3]).includes('/releases?')) {
        return { stdout: JSON.stringify([
          release('v0.3.0', true),
          release('v0.4.0', false),
          { ...release('v9.0.0', true), prerelease: true },
          { ...release('v8.0.0', true), draft: true },
        ]), stderr: '' };
      }
      return { stdout: `${'a'.repeat(40)}\n`, stderr: '' };
    });
    const source = new GitHubReleaseSource('maxverse-ai/aria', { run });

    await expect(source.list('stable')).resolves.toEqual([expect.objectContaining({
      tag: 'v0.3.0',
      version: '0.3.0',
      immutable: true,
    })]);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

function release(tag: string, immutable: boolean) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    immutable,
    published_at: '2026-08-29T00:00:00Z',
    assets: ['release.json', 'manifest.json', 'SHA256SUMS', 'aria-install.mjs', 'aria.tgz']
      .map((name) => ({ name })),
  };
}
