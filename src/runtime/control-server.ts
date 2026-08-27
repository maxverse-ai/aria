import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { RuntimeActivitySnapshotV1 } from './activity';
import {
  RUNTIME_CONTROL_PROTOCOL_VERSION,
  type RuntimeControlRequestV1,
  type RuntimeControlResponseV1,
  type RuntimeControlSidecarV1,
} from './control-protocol';

const MAX_REQUEST_BYTES = 64 * 1024;

export interface RuntimeControlServerOptions {
  profile: string;
  endpoint: string;
  sidecarFile: string;
  snapshot(): RuntimeActivitySnapshotV1;
  now?: () => Date;
}

export interface RuntimeControlServerHandle {
  readonly instanceId: string;
  close(): Promise<void>;
}

export async function startRuntimeControlServer(
  options: RuntimeControlServerOptions,
): Promise<RuntimeControlServerHandle> {
  const instanceId = randomUUID();
  const token = randomBytes(32).toString('hex');
  const now = options.now ?? (() => new Date());
  const sockets = new Set<Socket>();
  await mkdir(dirname(options.sidecarFile), { recursive: true });
  if (process.platform !== 'win32') {
    await rm(options.endpoint, { force: true });
    await mkdir(dirname(options.endpoint), { recursive: true });
  }

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    receiveRequest(socket, options, token);
  });
  await listen(server, options.endpoint);
  if (process.platform !== 'win32') await chmod(options.endpoint, 0o600);

  const sidecar: RuntimeControlSidecarV1 = {
    schemaVersion: RUNTIME_CONTROL_PROTOCOL_VERSION,
    profile: options.profile,
    pid: process.pid,
    instanceId,
    endpoint: options.endpoint,
    token,
    createdAt: now().toISOString(),
  };
  try {
    await writeFileAtomic(options.sidecarFile, `${JSON.stringify(sidecar, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    await closeServer(server, sockets);
    if (process.platform !== 'win32') await rm(options.endpoint, { force: true });
    throw err;
  }
  log.info('runtime-control', 'started', { profile: options.profile, instanceId });

  return {
    instanceId,
    async close() {
      await closeServer(server, sockets);
      await removeOwnedSidecar(options.sidecarFile, instanceId);
      if (process.platform !== 'win32') await rm(options.endpoint, { force: true });
      log.info('runtime-control', 'stopped', { profile: options.profile, instanceId });
    },
  };
}

function receiveRequest(socket: Socket, options: RuntimeControlServerOptions, token: string): void {
  socket.setEncoding('utf8');
  let body = '';
  socket.on('data', (chunk: string) => {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      writeResponse(socket, errorResponse('INVALID_REQUEST', 'request too large'));
      return;
    }
    const newline = body.indexOf('\n');
    if (newline < 0) return;
    socket.removeAllListeners('data');
    let request: RuntimeControlRequestV1;
    try {
      request = JSON.parse(body.slice(0, newline)) as RuntimeControlRequestV1;
    } catch {
      writeResponse(socket, errorResponse('INVALID_REQUEST', 'invalid JSON'));
      return;
    }
    if (!validToken(request.token, token)) {
      writeResponse(socket, errorResponse('UNAUTHORIZED', 'invalid control token'));
      return;
    }
    if (request.schemaVersion !== RUNTIME_CONTROL_PROTOCOL_VERSION || request.method !== 'restart.preflight') {
      writeResponse(socket, errorResponse('INVALID_REQUEST', 'unsupported control request'));
      return;
    }
    if (request.profile !== options.profile) {
      writeResponse(socket, errorResponse('PROFILE_MISMATCH', 'profile does not match endpoint'));
      return;
    }
    writeResponse(socket, {
      schemaVersion: RUNTIME_CONTROL_PROTOCOL_VERSION,
      ok: true,
      result: options.snapshot(),
    });
  });
}

function validToken(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

function errorResponse(
  code: 'UNAUTHORIZED' | 'INVALID_REQUEST' | 'PROFILE_MISMATCH',
  message: string,
): RuntimeControlResponseV1 {
  return {
    schemaVersion: RUNTIME_CONTROL_PROTOCOL_VERSION,
    ok: false,
    error: { code, message },
  };
}

function writeResponse(socket: Socket, response: RuntimeControlResponseV1): void {
  socket.end(`${JSON.stringify(response)}\n`);
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

async function closeServer(server: Server, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function removeOwnedSidecar(path: string, instanceId: string): Promise<void> {
  try {
    const current = JSON.parse(await readFile(path, 'utf8')) as { instanceId?: unknown };
    if (current.instanceId === instanceId) await rm(path, { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('runtime-control', 'sidecar-cleanup-failed', { err: String(err) });
    }
  }
}
