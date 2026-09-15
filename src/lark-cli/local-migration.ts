import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { principalId, type SpaceKey } from '../space/identity';
import { assertConfinedPath, resolveSpacePaths, within } from '../space/paths';
import { readPrivateJson } from '../space/deployment';

/** Transitional public migration boundary for image-owned local CLI packages.
 * Copies only the selected durable grant, config and encrypted keystore. Never
 * imports pending logins, logs, lock files or another user's credentials. Source
 * remains untouched for backup/recovery. Call under exclusive Space ownership. */
export async function copyLegacyLarkCliState(input: {
  stateDirectory: string; key: SpaceKey; cliDirectory: string; dataDirectory: string; signal?: AbortSignal;
}): Promise<{ migrated: boolean; appId?: string; files: number }> {
  if (input.key.kind !== 'user') return { migrated: false, files: 0 };
  const key = input.key;
  const paths = resolveSpacePaths(input.stateDirectory, key);
  for (const path of [input.cliDirectory, input.dataDirectory]) {
    if (!within(paths.engine, path)) throw new Error('CLI migration target belongs to another Space');
    await assertConfinedPath(paths.engine, path);
  }
  let store: { schema: string; profileId: string; grants: {spaceId: string; principalId: string; providerId: string; credentialRef: string}[] };
  try { store = await readPrivateJson(join(input.stateDirectory, 'space-control', 'tool-identity.v1.json'), join(input.stateDirectory, 'space-control')) as typeof store; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { migrated: false, files: 0 }; throw error; }
  if (!store || !['aria.space.tool-identity.v1', 'aria.space.tool-identity.v2'].includes(store.schema) || store.profileId !== key.profileId || !Array.isArray(store.grants)) throw new Error('legacy CLI identity store is invalid');
  const grants = store.grants.filter(g => g && g.spaceId === paths.spaceId && g.principalId === principalId(key.principal) && g.providerId === 'lark');
  if (!grants.length) return { migrated: false, files: 0 };
  if (grants.length !== 1 || !/^[a-f0-9-]{36}$/.test(grants[0]!.credentialRef)) throw new Error('legacy CLI grant is ambiguous');
  const source = join(input.stateDirectory, 'space-control', 'tool-credentials', createHash('sha256').update(grants[0]!.credentialRef).digest('hex'));
  const binding = await readPrivateJson(join(source, 'binding.json'), source) as Record<string, unknown>;
  if (binding.schema !== 'aria.space.lark-cli.v1' || binding.spaceId !== paths.spaceId
    || binding.owner !== principalId(key.principal) || binding.authorityId !== key.principal.authorityId
    || binding.identity !== 'user' || typeof binding.accountId !== 'string' || !/^cli_[a-z0-9]+$/.test(binding.accountId)) {
    throw new Error('legacy CLI credential owner differs');
  }
  const pairs = [[join(source, 'cli', 'lark-channel', 'config.json'), join(input.cliDirectory, 'lark-channel', 'config.json')]];
  const keys = join(source, 'home', '.local', 'share', 'lark-cli');
  await assertConfinedPath(source, keys);
  for (const entry of await readdir(keys, { withFileTypes: true })) {
    if (!entry.isFile() || !/^(?:master\.key|[a-zA-Z0-9_-]+\.enc)$/.test(entry.name)) throw new Error('unsupported legacy CLI keystore entry');
    pairs.push([join(keys, entry.name), join(input.dataDirectory, entry.name)]);
  }
  // Reject partial/foreign targets before copying any file. A failed migration
  // retains both sides for explicit recovery, never silently merges keystores.
  for (const [from, to] of pairs) {
    await assertConfinedPath(source, from!); await assertConfinedPath(paths.engine, to!);
    const info = await lstat(from!);
    if (!info.isFile() || info.size > 8 * 1024 * 1024 || (info.mode & 0o077)) throw new Error('unsafe legacy CLI migration source');
    if (await lstat(to!).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error('CLI migration target already exists');
  }
  await mkdir(join(input.cliDirectory, 'lark-channel'), { recursive: true, mode: 0o700 });
  await mkdir(input.dataDirectory, { recursive: true, mode: 0o700 });
  for (const [from, to] of pairs) {
    input.signal?.throwIfAborted();
    await copyFile(from!, to!, constants.COPYFILE_EXCL);
    const digest = async (p: string) => createHash('sha256').update(await readFile(p)).digest('hex');
    if (await digest(from!) !== await digest(to!)) throw new Error('CLI migration checksum differs');
  }
  return { migrated: true, appId: binding.accountId, files: pairs.length };
}
