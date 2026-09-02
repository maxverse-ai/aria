import { readFile, stat } from 'node:fs/promises';

import type { UiServerDeps } from './types';

export const UI_PORT_ENV = 'ARIA_UI_PORT';
export const UI_TOKEN_FILE_ENV = 'ARIA_UI_TOKEN_FILE';
export const UI_ALLOWED_ORIGINS_ENV = 'ARIA_UI_ALLOWED_ORIGINS';

type UiEnvironment = Pick<UiServerDeps, 'port' | 'token' | 'allowedOrigins'>;

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${UI_PORT_ENV} must be an integer from 1 to 65535`);
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${UI_PORT_ENV} must be an integer from 1 to 65535`);
  }
  return port;
}

function parseAllowedOrigins(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const origins = value.split(',').map((entry) => entry.trim());
  if (origins.some((entry) => !entry)) {
    throw new Error(`${UI_ALLOWED_ORIGINS_ENV} must contain exact comma-separated origins`);
  }
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`${UI_ALLOWED_ORIGINS_ENV} contains an invalid origin`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`${UI_ALLOWED_ORIGINS_ENV} must contain exact http(s) origins without paths`);
    }
  }
  return [...new Set(origins)];
}

async function readTokenFile(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${UI_TOKEN_FILE_ENV} must point to a regular file`);
  if (process.platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new Error(`${UI_TOKEN_FILE_ENV} must not be accessible by group or other users`);
  }
  const token = (await readFile(path, 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    throw new Error(`${UI_TOKEN_FILE_ENV} must contain exactly 64 hexadecimal characters`);
  }
  return token;
}

/**
 * Resolve the opt-in reverse-proxy deployment contract. With no variables set,
 * the console keeps its safe local defaults: ephemeral port, random token, and
 * localhost-only origins.
 */
export async function uiEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UiEnvironment> {
  const port = parsePort(env[UI_PORT_ENV]);
  const token = await readTokenFile(env[UI_TOKEN_FILE_ENV]?.trim());
  const allowedOrigins = parseAllowedOrigins(env[UI_ALLOWED_ORIGINS_ENV]);
  return {
    ...(port === undefined ? {} : { port }),
    ...(token === undefined ? {} : { token }),
    ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
  };
}
