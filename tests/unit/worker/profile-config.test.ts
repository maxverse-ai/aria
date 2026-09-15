import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { normalizeProfileConfig } from '../../../src/config/profile-schema';
import { discoverWorkerProfiles } from '../../../src/worker/discovery';
import { loadWorkerConfig, resolveWorkerProfile } from '../../../src/worker/profile-config';

const dirs: string[] = [];
const profile = { agentKind: 'codex', codex: { binaryPath: 'codex' }, workspaces: { default: '/workspace' } };
async function config(profiles: unknown = { coding: profile }, activeProfile = 'coding') {
  const dir = await mkdtemp(join(tmpdir(), 'aria-standalone-'));
  dirs.push(dir);
  const file = join(dir, 'config.json');
  await writeFile(file, JSON.stringify({ kind: 'aria-worker', schemaVersion: 1, activeProfile, profiles }));
  return file;
}
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

it('loads and discovers a real engine with no channel credentials', async () => {
  const file = await config();
  const resolved = await resolveWorkerProfile(file, 'coding');
  expect(resolved?.profileConfig.agentKind).toBe('codex');
  expect(resolved?.profileConfig).not.toHaveProperty('accounts');
  expect(resolved?.profileConfig.workspaces.default).toBe('/workspace');
  expect(await discoverWorkerProfiles(file)).toEqual({ protocolVersion: 1, profiles: [{ profile: 'coding', engine: 'codex', connectable: true }] });
  await expect(resolveWorkerProfile(file, 'other')).rejects.toThrow('unavailable');
  expect(() => normalizeProfileConfig({ ...profile, schemaVersion: 2 })).toThrow();
});

it('keeps worker profile state identities separate', async () => {
  const file = await config({ coding: profile, review: profile });
  const coding = await resolveWorkerProfile(file, 'coding');
  const review = await resolveWorkerProfile(file, 'review');
  expect(coding?.appPaths.profileDir).not.toBe(review?.appPaths.profileDir);
});

it.each(['accounts', 'channels', 'secrets', 'schemaVersion'])('rejects channel configuration field %s', async field => {
  await expect(loadWorkerConfig(await config({ coding: { ...profile, [field]: {} } }))).rejects.toThrow();
});

it('rejects unsafe names and absent active identities', async () => {
  await expect(loadWorkerConfig(await config({ '../escape': profile }))).rejects.toThrow();
  await expect(loadWorkerConfig(await config({}, 'missing'))).rejects.toThrow();
});
