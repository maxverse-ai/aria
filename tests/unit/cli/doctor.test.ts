import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDoctor, runDoctor, type DoctorSnapshot } from '../../../src/cli/commands/doctor';
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

describe('doctor CLI handler', () => {
  it('reports ok when config, keystore and engine resolve', async () => {
    const rootDir = await fixture(process.execPath);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const code = await runDoctor({ rootDir, profile: 'primary', json: true });

    const snapshot = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as DoctorSnapshot;
    expect(snapshot.schema).toBe('aria.doctor.v1');
    const checks = Object.fromEntries(snapshot.checks.map((check) => [check.id, check.status]));
    expect(checks.config).toBe('ok');
    expect(checks.profile).toBe('ok');
    expect(checks.engine).toBe('ok');
    expect(checks.keystore).toBe('ok');
    expect(snapshot.status).toBe('ok');
    expect(code).toBe(0);
  });

  it('exits non-zero when a check fails', async () => {
    const rootDir = await fixture('definitely-not-an-engine-binary-xyz');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const code = await runDoctor({ rootDir, profile: 'primary', json: true });

    const snapshot = JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0])) as DoctorSnapshot;
    expect(snapshot.status).toBe('failed');
    expect(snapshot.checks.find((check) => check.id === 'engine')?.status).toBe('fail');
    expect(code).toBe(1);
  });

  it('fails cleanly without a root config', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'aria-doctor-empty-'));
    roots.push(rootDir);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const code = await runDoctor({ rootDir, json: true });

    expect(code).toBe(1);
  });

  it('formats check lines with status icons', () => {
    const text = formatDoctor({
      schema: 'aria.doctor.v1',
      apiVersion: 1,
      status: 'failed',
      profile: 'primary',
      checks: [
        { id: 'config', status: 'ok', message: 'loaded' },
        { id: 'engine', status: 'fail', message: 'missing' },
      ],
    });
    expect(text).toContain('✓ config: loaded');
    expect(text).toContain('✗ engine: missing');
  });
});

async function fixture(binaryPath: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'aria-doctor-cli-'));
  roots.push(rootDir);
  const appPaths = resolveAppPaths({ rootDir, profile: 'primary' });
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: 'secret-test', tenant: 'feishu' } },
    codex: { binaryPath },
  });
  await saveRootConfig(createRootConfig('primary', profile), appPaths.configFile);
  await writeActiveProfile(rootDir, 'primary');
  return rootDir;
}
