import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLogs } from '../../../src/cli/commands/logs';
import { resolveAppPaths } from '../../../src/config/app-paths';
import {
  createRootConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('logs CLI handler', () => {
  it('prints the last N lines of the daemon stderr log', async () => {
    const rootDir = await fixture();
    const logDir = join(resolveAppPaths({ rootDir, profile: 'primary' }).logsDir, 'daemon');
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, 'daemon-stderr.log'), 'l1\nl2\nl3\nl4\nl5\n');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runLogs({ rootDir, profile: 'primary', lines: '2' });

    expect(out).toHaveBeenCalledWith('l4\nl5\n');
  });

  it('selects the stdout log with --stdout', async () => {
    const rootDir = await fixture();
    const logDir = join(resolveAppPaths({ rootDir, profile: 'primary' }).logsDir, 'daemon');
    await mkdir(logDir, { recursive: true });
    await writeFile(join(logDir, 'daemon-stdout.log'), 'out1\nout2\n');
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runLogs({ rootDir, profile: 'primary', stdout: true });

    expect(out).toHaveBeenCalledWith('out1\nout2\n');
  });

  it('validates --lines and reports a missing log', async () => {
    const rootDir = await fixture();
    await expect(runLogs({ rootDir, profile: 'primary', lines: 'abc' })).rejects.toThrow(
      '--lines must be a positive integer',
    );
    await expect(runLogs({ rootDir, profile: 'primary' })).rejects.toThrow('no daemon log at');
  });
});

async function fixture(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'aria-logs-cli-'));
  roots.push(rootDir);
  const appPaths = resolveAppPaths({ rootDir, profile: 'primary' });
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: 'secret-test', tenant: 'feishu' } },
    codex: { binaryPath: 'codex' },
  });
  await saveRootConfig(createRootConfig('primary', profile), appPaths.configFile);
  await writeActiveProfile(rootDir, 'primary');
  return rootDir;
}
