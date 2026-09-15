export const WEB_PREVIEW_BASE_ENV = 'ARIA_WEB_PREVIEW_BASE';
export const WEB_PREVIEW_PORT_ENV = 'ARIA_WEB_PREVIEW_PORT';
export const WEB_PREVIEW_API_TARGET_ENV = 'ARIA_WEB_PREVIEW_API_TARGET';
export const WEB_PREVIEW_API_MODE_ENV = 'ARIA_WEB_PREVIEW_API_MODE';
export const WEB_PREVIEW_WRITE_CONFIRM_ENV = 'ARIA_WEB_PREVIEW_WRITE_CONFIRM';
export const WEB_PREVIEW_PUBLIC_ORIGIN_ENV = 'ARIA_WEB_PREVIEW_PUBLIC_ORIGIN';

const WRITE_CONFIRMATION = 'isolated-development-backend';

export interface WebPreviewConfig {
  base: string;
  port: number;
  apiPrefix: string;
  apiTarget?: string;
  apiMode: 'read-only' | 'write';
  publicOrigin?: string;
}

/**
 * Resolve the independently served console preview. The preview is read-only
 * unless an operator explicitly confirms that its API target is an isolated
 * development backend.
 */
export function webPreviewConfig(env: NodeJS.ProcessEnv = process.env): WebPreviewConfig {
  const base = normalizeBase(env[WEB_PREVIEW_BASE_ENV] ?? '/aria-dev/');
  const port = normalizePort(env[WEB_PREVIEW_PORT_ENV] ?? '5174');
  const apiTarget = normalizeApiTarget(env[WEB_PREVIEW_API_TARGET_ENV]);
  const apiMode = normalizeApiMode(env);
  const publicOrigin = normalizePublicOrigin(env[WEB_PREVIEW_PUBLIC_ORIGIN_ENV]);
  return {
    base,
    port,
    apiPrefix: `${base}api`,
    ...(apiTarget ? { apiTarget } : {}),
    apiMode,
    ...(publicOrigin ? { publicOrigin } : {}),
  };
}

export function rewritePreviewApiPath(path: string, config: Pick<WebPreviewConfig, 'apiPrefix'>): string {
  if (path !== config.apiPrefix && !path.startsWith(`${config.apiPrefix}/`)) return path;
  return `/api${path.slice(config.apiPrefix.length)}`;
}

export function previewApiRequestDecision(
  method: string,
  config: Pick<WebPreviewConfig, 'apiTarget' | 'apiMode'>,
): 'proxy' | 'unconfigured' | 'method-not-allowed' {
  if (!config.apiTarget) return 'unconfigured';
  if (config.apiMode === 'read-only' && method !== 'GET' && method !== 'HEAD') {
    return 'method-not-allowed';
  }
  return 'proxy';
}

function normalizeBase(value: string): string {
  const candidate = value.trim();
  if (!candidate.startsWith('/') || !candidate.endsWith('/') || candidate.includes('//')) {
    throw new Error(`${WEB_PREVIEW_BASE_ENV} must be one absolute path segment ending in /`);
  }
  const segments = candidate.split('/').filter(Boolean);
  if (segments.length !== 1 || segments[0] === '.' || segments[0] === '..') {
    throw new Error(`${WEB_PREVIEW_BASE_ENV} must be one absolute path segment ending in /`);
  }
  return candidate;
}

function normalizePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${WEB_PREVIEW_PORT_ENV} must be an integer from 1 through 65535`);
  }
  return port;
}

function normalizeApiTarget(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  let target: URL;
  try {
    target = new URL(candidate);
  } catch {
    throw new Error(`${WEB_PREVIEW_API_TARGET_ENV} must be a loopback HTTP origin`);
  }
  const loopback = target.hostname === '127.0.0.1'
    || target.hostname === 'localhost'
    || target.hostname === '[::1]';
  if (target.protocol !== 'http:' || !loopback || target.username || target.password
    || target.pathname !== '/' || target.search || target.hash) {
    throw new Error(`${WEB_PREVIEW_API_TARGET_ENV} must be a loopback HTTP origin`);
  }
  return target.origin;
}

function normalizeApiMode(env: NodeJS.ProcessEnv): 'read-only' | 'write' {
  const value = (env[WEB_PREVIEW_API_MODE_ENV] ?? 'read-only').trim();
  if (value !== 'read-only' && value !== 'write') {
    throw new Error(`${WEB_PREVIEW_API_MODE_ENV} must be read-only or write`);
  }
  if (value === 'write' && env[WEB_PREVIEW_WRITE_CONFIRM_ENV] !== WRITE_CONFIRMATION) {
    throw new Error(
      `${WEB_PREVIEW_WRITE_CONFIRM_ENV} must equal ${WRITE_CONFIRMATION} before preview writes are enabled`,
    );
  }
  return value;
}

function normalizePublicOrigin(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return undefined;
  let origin: URL;
  try {
    origin = new URL(candidate);
  } catch {
    throw new Error(`${WEB_PREVIEW_PUBLIC_ORIGIN_ENV} must be an exact HTTP(S) origin`);
  }
  if ((origin.protocol !== 'http:' && origin.protocol !== 'https:')
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error(`${WEB_PREVIEW_PUBLIC_ORIGIN_ENV} must be an exact HTTP(S) origin`);
  }
  return origin.origin;
}
