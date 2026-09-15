import { createServer, connect, isIP, type Server, type Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import { chmod, rm, open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
import { assertConfinedPath, type SpacePaths } from './paths';

export interface ModelEgressRule { readonly hostname: string; readonly port: number }
export interface SpaceEgressBroker {
  readonly socket: string;
  readonly proxyEntry: string;
  close(): Promise<void>;
}

/** Defense against DNS rebinding into host/control networks. IPv6 is conservatively
 * disabled until a deployment supplies a separately verified IPv6 routing policy. */
export function publicModelAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const octets = address.split('.').map(Number);
  const a = octets[0]!; const b = octets[1]!;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
    || (a === 192 && b === 0) || (a === 192 && b === 88 && octets[2] === 99)
    || (a === 198 && b === 51 && octets[2] === 100) || (a === 203 && b === 0 && octets[2] === 113));
}

/** An engine has no host network namespace. Only explicitly admitted TLS model
 * endpoints are reachable via this socket; there is no generic host HTTP proxy. */
export async function startSpaceEgress(input: {
  paths: SpacePaths; endpoints: readonly ModelEgressRule[]; maxConnections?: number;
}): Promise<SpaceEgressBroker> {
  const allowed = new Set(input.endpoints.map((rule) => {
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(rule.hostname) || isIP(rule.hostname)
      || !rule.hostname.includes('.') || rule.port !== 443) throw new Error('invalid model egress rule');
    return `${rule.hostname.toLowerCase()}:${rule.port}`;
  }));
  const max = input.maxConnections ?? 32;
  if (!Number.isSafeInteger(max) || max < 1 || max > 256) throw new Error('invalid model connection limit');
  // Keep the socket in host-owned control state; the fd-relative bind below also
  // supports long profile paths without using a global shared socket directory.
  const socket = await assertConfinedPath(input.paths.control, join(input.paths.control, 'egress.sock'));
  if (process.platform !== 'linux') throw new Error('space model egress requires Linux');
  const proxyEntry = await assertConfinedPath(input.paths.control, join(input.paths.control, 'proxy.mjs'));
  await writeFileAtomic(proxyEntry, SPACE_PROXY_ENTRY, { mode: 0o600 });
  const sockets = new Set<Socket>();
  let closed = false;
  const server = createServer((client) => {
    if (closed || sockets.size >= max * 2) { client.destroy(); return; }
    sockets.add(client); client.once('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    client.setTimeout(30_000, () => client.destroy());
    let header = Buffer.alloc(0);
    const onData = (data: Buffer) => {
      header = Buffer.concat([header, data]);
      if (header.length > 16_384) { client.destroy(); return; }
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.pause(); client.removeListener('data', onData);
      const first = header.subarray(0, end).toString('ascii').split('\r\n')[0]!;
      const match = /^CONNECT ([a-zA-Z0-9.-]+):443 HTTP\/1\.[01]$/.exec(first);
      if (!match || !allowed.has(`${match[1]!.toLowerCase()}:443`)) {
        client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
      }
      void (async () => {
        const addresses = await lookup(match[1]!, { all: true, family: 4 });
        if (closed || !addresses.length || addresses.some((a) => !publicModelAddress(a.address))) throw new Error('model address is not public');
        const upstream = connect({ host: addresses[0]!.address, port: 443 });
        sockets.add(upstream); upstream.once('close', () => { sockets.delete(upstream); client.destroy(); });
        client.once('close', () => upstream.destroy());
        upstream.on('error', () => { upstream.destroy(); client.destroy(); });
        upstream.setTimeout(30_000, () => upstream.destroy());
        upstream.once('connect', () => {
          if (closed) { upstream.destroy(); client.destroy(); return; }
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          const tail = header.subarray(end + 4);
          if (tail.length) upstream.write(tail);
          client.pipe(upstream); upstream.pipe(client); client.resume();
        });
      })().catch(() => client.destroy());
    };
    client.on('data', onData);
  });
  const directory = await open(input.paths.control, 'r');
  try {
    const shortPath = `/proc/self/fd/${directory.fd}/egress.sock`;
    await removeStaleSocket(socket, shortPath);
    await listen(server, shortPath); await chmod(socket, 0o600);
  }
  catch (error) { server.close(); await directory.close(); throw error; }
  let closing: Promise<void> | undefined;
  return { socket, proxyEntry, close() {
    closing ??= (async () => {
      closed = true; for (const connection of sockets) connection.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await directory.close();
      await rm(socket, { force: true });
    })();
    return closing;
  } };
}
function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(path, () => { server.removeListener('error', reject); resolve(); });
  });
}
async function removeStaleSocket(path: string, connectPath: string): Promise<void> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!info) return;
  if (!info.isSocket()) throw new Error('model broker path is not a socket');
  await new Promise<void>((resolve, reject) => {
    const probe = connect(connectPath);
    probe.once('connect', () => { probe.destroy(); reject(new Error('space model broker is already running')); });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      probe.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(); else reject(error);
    });
    probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('space model broker ownership is unavailable')); });
  });
  const current = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (current && (current.dev !== info.dev || current.ino !== info.ino)) throw new Error('space model broker ownership changed');
  await rm(path, { force: true });
}

// Executed inside the already-created namespace. It owns the engine process and
// forwards only CONNECT requests to the host's space-specific allowlist broker.
const SPACE_PROXY_ENTRY = `import net from 'node:net';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { open } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
const [socket, binary, ...args] = process.argv.slice(2);
// Both sides must use fd-relative paths: execution backends retain the full
// Space path, which can exceed the Linux sockaddr_un pathname limit.
const directory = await open(dirname(socket), 'r');
const connectPath = '/proc/self/fd/' + directory.fd + '/' + basename(socket);
const peers = new Set();
const server = net.createServer((client) => {
  const upstream = net.connect(connectPath);
  peers.add(client); peers.add(upstream);
  const close = () => { client.destroy(); upstream.destroy(); peers.delete(client); peers.delete(upstream); };
  client.on('error', close); upstream.on('error', close);
  client.on('close', close); upstream.on('close', close);
  client.pipe(upstream); upstream.pipe(client);
});
server.listen(0, '127.0.0.1', () => {
  const proxy = 'http://127.0.0.1:' + server.address().port;
  // Keep native engine descriptors separate from the outer exec transport.
  // The stream pumps own backpressure and must drain before the wrapper exits.
  const child = spawn(binary, args, { stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env,
    HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
    NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1' } });
  let failed = false;
  let deadline;
  const cleanup = (code) => {
    for (const peer of peers) peer.destroy();
    server.close();
    void directory.close().finally(() => process.exit(code));
  };
  const boundShutdown = () => {
    if (deadline) return;
    deadline = setTimeout(() => { child.kill('SIGKILL'); cleanup(1); }, 10000);
    deadline.unref();
  };
  const transportFailed = () => {
    failed = true;
    child.kill('SIGTERM');
    boundShutdown();
  };
  const exited = new Promise((resolve) => {
    child.once('error', () => { failed = true; boundShutdown(); resolve(127); });
    child.once('exit', (code, signal) => {
      boundShutdown();
      resolve(code ?? (signal === 'SIGTERM' ? 143 : signal === 'SIGINT' ? 130 : 1));
    });
  });
  const relay = async (source, destination) => {
    await pipeline(source, destination, { end: false });
    // end:false leaves the process stream open. Explicitly wait for preceding
    // writes: source EOF alone does not imply that the outer transport drained.
    await new Promise((resolve, reject) => destination.write('', error => error ? reject(error) : resolve()));
  };
  const outputs = [relay(child.stdout, process.stdout), relay(child.stderr, process.stderr)]
    .map(p => p.catch(transportFailed));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    child.kill(signal);
    boundShutdown();
  });
  void Promise.all([exited, ...outputs]).then(([code]) => {
    clearTimeout(deadline);
    cleanup(failed ? 1 : code);
  });
});
`;
