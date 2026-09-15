import pkg from '../../package.json';
import { readFile, stat } from 'node:fs/promises';
import { createPublicKey } from 'node:crypto';
import { join } from 'node:path';
import type { NativeReadScope } from '../platform/native-read-http-server';
import { DefaultNativeReadProfileRuntime } from './native-read-runtime';
import type { NativeReadRuntimeFactory } from './native-read-runtime';

const ENABLED_VALUES = new Set(['1', 'true', 'yes']);
const NATIVE_READ_SCOPES = new Set<NativeReadScope>([
  'read:meta',
  'read:profiles',
  'read:sessions',
  'read:messages',
  'read:message-content',
  'read:runs',
  'read:identities',
  'read:chats',
  'read:audit',
  'read:changes',
]);

export interface NativeReadEnvironmentOptions {
  rootDir: string;
  serverVersion?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Builds the Supervisor's native-read factory from explicit process settings.
 *
 * The default remains disabled. Enabling fails closed unless a private token
 * file and a non-empty, allowlisted scope set are supplied. The token never
 * enters config.json, command arguments, logs, or the process environment.
 */
export async function nativeReadFactoryFromEnvironment(
  options: NativeReadEnvironmentOptions,
): Promise<NativeReadRuntimeFactory | undefined> {
  const env = options.env ?? process.env;
  if (!ENABLED_VALUES.has((env.ARIA_NATIVE_READ_ENABLED ?? '').trim().toLowerCase())) {
    return undefined;
  }

  const tokenFile = (env.ARIA_NATIVE_READ_TOKEN_FILE ?? '').trim()
    || join(options.rootDir, 'native-read.token');
  const tokenInfo = await stat(tokenFile).catch((error: unknown) => {
    throw new Error(`native read token file is unavailable: ${publicFileError(error)}`);
  });
  if (!tokenInfo.isFile()) throw new Error('native read token path must be a regular file');
  if (process.platform !== 'win32' && (tokenInfo.mode & 0o077) !== 0) {
    throw new Error('native read token file must have mode 0600');
  }
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!token) throw new Error('native read token file is empty');

  const scopes = parseScopes(env.ARIA_NATIVE_READ_SCOPES);
  const managementProfiles = new Set((env.ARIA_NATIVE_READ_MANAGEMENT_PROFILES ?? '').split(',').map(x => x.trim()).filter(Boolean));
  const managementFile = env.ARIA_NATIVE_READ_MANAGEMENT_PUBLIC_KEY_FILE?.trim();
  let managementPublicKey: string | undefined;
  if (managementFile || managementProfiles.size) {
    if (!managementFile || !managementProfiles.size) throw new Error('management read requires an explicit public key file and profile allowlist');
    const info = await stat(managementFile).catch(() => { throw new Error('management public key file unavailable'); });
    if (!info.isFile() || info.size > 4096) throw new Error('invalid management public key file');
    managementPublicKey = (await readFile(managementFile, 'utf8')).trim();
    if (!managementPublicKey.startsWith('-----BEGIN PUBLIC KEY-----') || createPublicKey(managementPublicKey).asymmetricKeyType !== 'ed25519') {
      throw new Error('management read requires an Ed25519 public key, never a private key');
    }
  }
  return ({ profile, appPaths, sessionCatalog, spaces }) => new DefaultNativeReadProfileRuntime({
    profileId: profile,
    appPaths,
    sessionCatalog,
    ...(spaces ? { spaces } : {}),
    token,
    ...(managementProfiles.has(profile) ? { managementPublicKey } : {}),
    scopes,
    serverVersion: options.serverVersion ?? pkg.version,
  });
}

function parseScopes(value: string | undefined): NativeReadScope[] {
  const raw = (value ?? '').split(',').map((scope) => scope.trim()).filter(Boolean);
  if (raw.length === 0) {
    throw new Error('ARIA_NATIVE_READ_SCOPES must contain at least one explicit scope');
  }
  const scopes: NativeReadScope[] = [];
  const seen = new Set<string>();
  for (const scope of raw) {
    if (!NATIVE_READ_SCOPES.has(scope as NativeReadScope)) {
      throw new Error(`unsupported native read scope: ${scope}`);
    }
    if (!seen.has(scope)) {
      scopes.push(scope as NativeReadScope);
      seen.add(scope);
    }
  }
  return scopes;
}

function publicFileError(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'UNKNOWN';
}
