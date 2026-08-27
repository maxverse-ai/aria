import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeReadScope } from '../platform/native-read-http-server';
import { DefaultNativeReadProfileRuntime } from './native-read-runtime';
import type { SupervisorOptions } from './supervisor';

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
  serverVersion: string;
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
): Promise<SupervisorOptions['createNativeReadRuntime'] | undefined> {
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
  return ({ profile, appPaths, sessionCatalog }) => new DefaultNativeReadProfileRuntime({
    profileId: profile,
    appPaths,
    sessionCatalog,
    token,
    scopes,
    serverVersion: options.serverVersion,
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
