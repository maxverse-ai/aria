import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WechatKfCallbackHandler } from './callback';

const MAX_CALLBACK_BYTES = 256 * 1024;

export interface WechatKfCallbackServerOptions {
  handler: WechatKfCallbackHandler;
  host?: string;
  port?: number;
  path?: string;
}

export interface WechatKfCallbackServerHandle {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  close(): Promise<void>;
}

/** Local HTTP transport intended to sit behind the deployment's TLS proxy. */
export async function startWechatKfCallbackServer(
  options: WechatKfCallbackServerOptions,
): Promise<WechatKfCallbackServerHandle> {
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 0;
  const path = options.path ?? '/wechat-kf/callback';
  if (!path.startsWith('/') || path.includes('?')) {
    throw new Error('invalid wechat-kf callback path');
  }
  const server = createServer((request, response) => {
    handleHttpRequest(request, response, options.handler, path).catch(() => {
      if (!response.headersSent) sendText(response, 500, 'internal error');
      else response.end();
    });
  });
  await listen(server, host, requestedPort);
  const address = server.address();
  if (!address || typeof address === 'string') {
    await close(server);
    throw new Error('wechat-kf callback server did not bind a TCP address');
  }
  return {
    host,
    port: (address as AddressInfo).port,
    path,
    close: () => close(server),
  };
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  handler: WechatKfCallbackHandler,
  callbackPath: string,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname !== callbackPath) {
    sendText(response, 404, 'not found');
    return;
  }
  if (request.method !== 'GET' && request.method !== 'POST') {
    response.setHeader('allow', 'GET, POST');
    sendText(response, 405, 'method not allowed');
    return;
  }
  const body = request.method === 'POST' ? await readBoundedBody(request) : undefined;
  if (body === undefined && request.method === 'POST') {
    sendText(response, 413, 'payload too large');
    return;
  }
  const result = await handler.handle({
    method: request.method,
    query: url.searchParams,
    ...(body !== undefined ? { body } : {}),
  });
  response.writeHead(result.status, {
    'content-type': result.contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(result.body);
}

function readBoundedBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_CALLBACK_BYTES) {
        exceeded = true;
        chunks.length = 0;
      } else if (!exceeded) {
        chunks.push(chunk);
      }
    });
    request.once('error', reject);
    request.on('end', () => resolve(exceeded ? undefined : Buffer.concat(chunks).toString('utf8')));
  });
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
