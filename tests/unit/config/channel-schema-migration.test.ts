import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyChannelSchemaV3Migration,
  migrateProfileConfigToSchemaV3,
  planChannelSchemaV3Migration,
  rollbackChannelSchemaV3Migration,
} from '../../../src/config/channel-schema-migration';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import {
  createRootConfig,
  loadRootConfig,
  saveRootConfig,
} from '../../../src/config/profile-store';

const roots: string[] = [];
const app = {
  id: 'cli_migrate',
  secret: { source: 'env' as const, id: 'LARK_APP_SECRET' },
  tenant: 'feishu' as const,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const rootDir = await mkdtemp(join(tmpdir(), 'aria-channel-schema-migration-'));
  roots.push(rootDir);
  const configPath = join(rootDir, 'config.json');
  const profile = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
  await saveRootConfig(createRootConfig('primary', profile), configPath);
  return { rootDir, configPath, backupPath: `${configPath}.schema-v2.backup` };
}

describe('channel schema v3 migration', () => {
  it('migrates a newly prepared profile without mutating the source', () => {
    const source = createDefaultProfileConfig({ agentKind: 'claude', accounts: { app } });
    const before = structuredClone(source);

    const migrated = migrateProfileConfigToSchemaV3('new-profile', source);

    expect(source).toEqual(before);
    expect(migrated.schemaVersion).toBe(3);
    expect(Object.keys(migrated.channels?.instances ?? {})).toEqual(['lark-primary']);
  });

  it('plans without mutation and never embeds credential material', async () => {
    const { configPath, backupPath } = await fixture();
    const before = await readFile(configPath, 'utf8');
    const plan = await planChannelSchemaV3Migration({ configPath });

    expect(plan).toMatchObject({
      schemaVersion: 1,
      sourceSchemaVersion: 2,
      targetSchemaVersion: 3,
      configPath,
      backupPath,
      profiles: [{ profileId: 'primary', channelInstances: ['lark-primary'] }],
    });
    expect(JSON.stringify(plan)).not.toContain('LARK_APP_SECRET');
    expect(await readFile(configPath, 'utf8')).toBe(before);
    await expect(access(backupPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('applies atomically, preserves an exact private backup, and rolls back byte-for-byte', async () => {
    const { configPath, backupPath } = await fixture();
    const before = await readFile(configPath, 'utf8');
    const plan = await planChannelSchemaV3Migration({ configPath });
    const applied = await applyChannelSchemaV3Migration(plan);

    expect(applied.backupReused).toBe(false);
    expect(await readFile(backupPath, 'utf8')).toBe(before);
    if (process.platform !== 'win32') {
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    }
    const migrated = await loadRootConfig(configPath);
    expect(migrated?.schemaVersion).toBe(3);
    expect(migrated?.profiles.primary?.schemaVersion).toBe(3);
    expect(migrated?.profiles.primary?.channels).toEqual({
      plugins: [],
      instances: {
        'lark-primary': {
          plugin: 'lark',
          enabled: true,
          configVersion: 1,
          config: {
            appId: app.id,
            tenant: app.tenant,
            credentialMode: 'secret-ref',
          },
          secretRefs: { appSecret: app.secret },
        },
      },
    });

    await rollbackChannelSchemaV3Migration({
      configPath,
      expectedCurrentRevision: applied.targetRevision,
    });
    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect((await loadRootConfig(configPath))?.schemaVersion).toBe(2);
  });

  it('rejects source drift before creating a backup', async () => {
    const { configPath, backupPath } = await fixture();
    const plan = await planChannelSchemaV3Migration({ configPath });
    const root = await loadRootConfig(configPath);
    root!.profiles.primary!.preferences.showToolCalls = false;
    await saveRootConfig(root!, configPath);

    await expect(applyChannelSchemaV3Migration(plan)).rejects.toThrow(/changed after.*planning/);
    expect((await loadRootConfig(configPath))?.schemaVersion).toBe(2);
    await expect(access(backupPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resumes safely when an identical backup was written before interruption', async () => {
    const { configPath, backupPath } = await fixture();
    const plan = await planChannelSchemaV3Migration({ configPath });
    await writeFile(backupPath, await readFile(configPath, 'utf8'), { mode: 0o600 });
    await chmod(backupPath, 0o644);

    const result = await applyChannelSchemaV3Migration(plan);
    expect(result.backupReused).toBe(true);
    if (process.platform !== 'win32') {
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    }
    expect((await loadRootConfig(configPath))?.schemaVersion).toBe(3);
  });

  it('restores the exact source when post-write validation fails', async () => {
    const { configPath, backupPath } = await fixture();
    const before = await readFile(configPath, 'utf8');
    const plan = await planChannelSchemaV3Migration({ configPath });

    await expect(applyChannelSchemaV3Migration(plan, {
      validateApplied: () => {
        throw new Error('injected post-write failure');
      },
    })).rejects.toThrow(/injected post-write failure/);

    expect(await readFile(configPath, 'utf8')).toBe(before);
    expect(await readFile(backupPath, 'utf8')).toBe(before);
    expect((await loadRootConfig(configPath))?.schemaVersion).toBe(2);
  });

  it('refuses to overwrite a different existing backup', async () => {
    const { configPath, backupPath } = await fixture();
    const plan = await planChannelSchemaV3Migration({ configPath });
    await writeFile(backupPath, '{"different":true}\n', { mode: 0o600 });

    await expect(applyChannelSchemaV3Migration(plan)).rejects.toThrow(/backup already exists/);
    expect((await loadRootConfig(configPath))?.schemaVersion).toBe(2);
  });
});
