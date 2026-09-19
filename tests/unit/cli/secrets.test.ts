import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runSecretsList, runSecretsRemove } from '../../../src/cli/commands/secrets';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { setSecret } from '../../../src/config/keystore';
import {
  createRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { secretKeyForApp } from '../../../src/config/schema';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('secrets CLI handlers', () => {
  it('refuses to remove a secret without --yes', async () => {
    const rootDir = await fixture();
    await expect(
      runSecretsRemove('cli_test', { rootDir, profile: 'primary' }),
    ).rejects.toThrow('secrets remove requires --yes');
  });

  it('removes an existing secret with --yes', async () => {
    const rootDir = await fixture();
    const appPaths = resolveAppPaths({ rootDir, profile: 'primary' });
    await setSecret(secretKeyForApp('cli_test'), 'secret-value', appPaths);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logs.push(String(line)));

    await runSecretsRemove('cli_test', { rootDir, profile: 'primary', yes: true });

    expect(logs.join('\n')).toContain('✓ removed app-cli_test');
  });

  it('reports a missing secret in English', async () => {
    const rootDir = await fixture();
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line) => errors.push(String(line)));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await runSecretsRemove('cli_missing', { rootDir, profile: 'primary', yes: true });

    expect(errors.join('\n')).toContain('✗ secret not found: app-cli_missing');
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('lists keystore ids in English', async () => {
    const rootDir = await fixture();
    const appPaths = resolveAppPaths({ rootDir, profile: 'primary' });
    await setSecret(secretKeyForApp('cli_test'), 'secret-value', appPaths);
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => logs.push(String(line)));

    await runSecretsList({ rootDir, profile: 'primary' });

    expect(logs.join('\n')).toContain('1 secret(s) in the encrypted keystore');
    expect(logs.join('\n')).toContain('app-cli_test');
  });
});

async function fixture(): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'aria-secrets-cli-'));
  roots.push(rootDir);
  const appPaths = resolveAppPaths({ rootDir, profile: 'primary' });
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: 'cli_test', secret: 'secret-test', tenant: 'feishu' } },
    codex: { binaryPath: 'codex' },
  });
  await saveRootConfig(createRootConfig('primary', profile), appPaths.configFile);
  return rootDir;
}
