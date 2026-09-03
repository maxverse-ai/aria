import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('update CLI process contract', () => {
  it('parses an exact target version inside update plan instead of invoking the root version flag', () => {
    const result = spawnSync(process.execPath, [
      join(process.cwd(), 'dist', 'cli.js'),
      'update',
      'plan',
      '--target-version',
      '0.2.1',
      '--help',
    ], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('Usage: aria update plan');
    expect(result.stdout).toContain('--target-version <version>');
  });
});
