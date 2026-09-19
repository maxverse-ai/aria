import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runProfileExport,
  runProfileImport,
} from '../../../src/cli/commands/profile';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { getSecret, listSecretIds } from '../../../src/config/keystore';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
  writeActiveProfile,
} from '../../../src/config/profile-store';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { secretKeyForApp } from '../../../src/config/schema';

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('profile import', () => {
  it('imports an exported profile with its plaintext secret into the keystore', async () => {
    const rootDir = await fixture('existing');
    const file = join(rootDir, 'export.json');
    const exportDoc = exportDocument('migrated', 'cli_moved', 'plain-secret-value');
    await writeFile(file, JSON.stringify(exportDoc));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runProfileImport(file, { rootDir });

    const root = await loadRootConfig(join(rootDir, 'config.json'));
    expect(root?.profiles.migrated).toBeDefined();
    // Plaintext never stays in config.json: the import stores it in the
    // keystore and writes the standard exec-provider account shape.
    const appPaths = resolveAppPaths({ rootDir, profile: 'migrated' });
    expect(await getSecret(secretKeyForApp('cli_moved'), appPaths)).toBe('plain-secret-value');
    expect(root?.profiles.migrated?.accounts.app.secret).toMatchObject({ source: 'exec' });
    expect(JSON.stringify(root)).not.toContain('plain-secret-value');
  });

  it('imports a redacted export only when --app-secret supplies the value', async () => {
    const rootDir = await fixture('existing');
    const file = join(rootDir, 'export-redacted.json');
    const doc = exportDocument('migrated', 'cli_moved', '[REDACTED]');
    delete doc.secrets;
    await writeFile(file, JSON.stringify(doc));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runProfileImport(file, { rootDir })).rejects.toThrow('redacted app secret');

    await runProfileImport(file, { rootDir, appSecret: 'user-supplied-secret' });
    const root = await loadRootConfig(join(rootDir, 'config.json'));
    expect(root?.profiles.migrated).toBeDefined();
    const appPaths = resolveAppPaths({ rootDir, profile: 'migrated' });
    expect(await getSecret(secretKeyForApp('cli_moved'), appPaths)).toBe('user-supplied-secret');
  });

  it('renames with --name and refuses to overwrite an existing profile', async () => {
    const rootDir = await fixture('existing');
    const file = join(rootDir, 'export2.json');
    await writeFile(file, JSON.stringify(exportDocument('existing', 'cli_x', 's')));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runProfileImport(file, { rootDir })).rejects.toThrow('already exists');

    await runProfileImport(file, { rootDir, name: 'renamed' });
    const root = await loadRootConfig(join(rootDir, 'config.json'));
    expect(root?.profiles.renamed).toBeDefined();
    expect(root?.profiles.existing).toBeDefined();
  });

  it('round-trips a --include-secrets export through import', async () => {
    process.env.ARIA_IMPORT_TEST_SECRET = 'secret-for-source';
    const rootDir = await fixture('source');
    const output = join(rootDir, 'roundtrip.json');
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line) => lines.push(String(line)));

    await runProfileExport('source', { rootDir, output, includeSecrets: true, yes: true });
    const exported = JSON.parse(await import('node:fs/promises').then((m) => m.readFile(output, 'utf8')));

    // Simulate the receiving machine: fresh root with an unrelated profile.
    const targetDir = await fixture('other');
    const file = join(targetDir, 'in.json');
    await writeFile(file, JSON.stringify(exported));
    await runProfileImport(file, { rootDir: targetDir });

    const root = await loadRootConfig(join(targetDir, 'config.json'));
    expect(root?.profiles.source?.accounts.app.id).toBe('cli_source');
    const appPaths = resolveAppPaths({ rootDir: targetDir, profile: 'source' });
    expect(await getSecret(secretKeyForApp('cli_source'), appPaths)).toBe('secret-for-source');
  });
});

async function fixture(activeName: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), 'aria-profile-import-'));
  roots.push(rootDir);
  const appPaths = resolveAppPaths({ rootDir, profile: activeName });
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: `cli_${activeName}`, secret: '${ARIA_IMPORT_TEST_SECRET}', tenant: 'feishu' } },
    codex: { binaryPath: 'codex' },
  });
  await saveRootConfig(createRootConfig(activeName, profile), appPaths.configFile);
  await writeActiveProfile(rootDir, activeName);
  return rootDir;
}

function exportDocument(name: string, appId: string, secret: unknown) {
  const profile = createDefaultProfileConfig({
    agentKind: 'codex',
    accounts: { app: { id: appId, secret, tenant: 'feishu' } },
    codex: { binaryPath: 'codex' },
  });
  const root = createRootConfig(name, profile);
  root.activeProfile = name;
  return root;
}
