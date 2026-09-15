import { readFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import type { RuntimeActivitySnapshotV1 } from './activity';
import {
  RUNTIME_CONTROL_PROTOCOL_VERSION,
  type RuntimeControlRequestV1,
  type RuntimeControlResponseV1,
  type RuntimeControlSidecarV1,
} from './control-protocol';

export type RuntimeControlUnavailableCode =
  | 'SIDECAR_MISSING'
  | 'SIDECAR_INVALID'
  | 'DAEMON_UNREACHABLE'
  | 'REQUEST_TIMEOUT'
  | 'PROTOCOL_ERROR';

export class RuntimeControlUnavailableError extends Error {
  constructor(readonly code: RuntimeControlUnavailableCode, message: string) {
    super(message);
    this.name = 'RuntimeControlUnavailableError';
  }
}

export async function requestRestartPreflight(
  sidecarFile: string,
  profile: string,
  timeoutMs = 2000,
): Promise<RuntimeActivitySnapshotV1> {
  return requestRuntimeControl(sidecarFile, profile, 'restart.preflight', timeoutMs);
}

export async function requestRuntimeControl(sidecarFile: string, profile: string,
  method: RuntimeControlRequestV1['method'], timeoutMs = 60_000): Promise<RuntimeActivitySnapshotV1> {
  const sidecar = await readSidecar(sidecarFile, profile);
  const request: RuntimeControlRequestV1 = {
    schemaVersion: RUNTIME_CONTROL_PROTOCOL_VERSION,
    method, timeoutMs,
    profile,
    token: sidecar.token,
  };
  const response = await exchange(sidecar.endpoint, request, method === 'transition.drain' ? timeoutMs + 2000 : timeoutMs);
  if (!response.ok) {
    throw new RuntimeControlUnavailableError('PROTOCOL_ERROR', response.error.message);
  }
  if (response.result.profile !== profile) {
    throw new RuntimeControlUnavailableError('PROTOCOL_ERROR', 'runtime response profile mismatch');
  }
  return response.result;
}

async function readSidecar(path: string, profile: string): Promise<RuntimeControlSidecarV1> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new RuntimeControlUnavailableError('SIDECAR_MISSING', 'runtime control sidecar not found');
    }
    throw new RuntimeControlUnavailableError('SIDECAR_INVALID', 'runtime control sidecar is invalid');
  }
  if (!isSidecar(parsed) || parsed.profile !== profile) {
    throw new RuntimeControlUnavailableError('SIDECAR_INVALID', 'runtime control sidecar does not match profile');
  }
  return parsed;
}

function exchange(
  endpoint: string,
  request: RuntimeControlRequestV1,
  timeoutMs: number,
): Promise<RuntimeControlResponseV1> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let body = '';
    let settled = false;
    const finish = (err?: Error, response?: RuntimeControlResponseV1): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else if (response) resolve(response);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => {
      finish(new RuntimeControlUnavailableError('REQUEST_TIMEOUT', 'runtime control request timed out'));
    });
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk: string) => {
      body += chunk;
      const newline = body.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(body.slice(0, newline)) as RuntimeControlResponseV1);
      } catch {
        finish(new RuntimeControlUnavailableError('PROTOCOL_ERROR', 'invalid runtime control response'));
      }
    });
    socket.once('error', (err) => {
      finish(new RuntimeControlUnavailableError('DAEMON_UNREACHABLE', err.message));
    });
    socket.once('end', () => {
      if (!settled) finish(new RuntimeControlUnavailableError('PROTOCOL_ERROR', 'empty runtime control response'));
    });
  });
}

function isSidecar(value: unknown): value is RuntimeControlSidecarV1 {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.schemaVersion === 1 &&
    typeof item.profile === 'string' &&
    typeof item.pid === 'number' &&
    typeof item.instanceId === 'string' &&
    typeof item.endpoint === 'string' &&
    typeof item.token === 'string' &&
    typeof item.createdAt === 'string';
}
