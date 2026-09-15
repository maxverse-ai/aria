import { createServer, type Server } from 'node:http';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spaceId, type SpaceKey } from './identity';
import type { AuthorizedSpaceContext, AuthorizedSpaceSnapshot, SpaceAuthorization } from './authorization';
import type { SpaceOperation, SpaceOperationGate } from './operation-gate';
import type { RunTools, RunToolLease } from '../runtime/run-tools';
import type { SpaceToolResult } from './tool-credentials';
import { assertConfinedPath, prepareSpacePaths, resolveSpacePaths } from './paths';
import { writeFileAtomic } from '../platform/atomic-write';

export interface SpaceNativeTool {
  readonly id: string;
  readonly authorityId: string;
  readonly description: string;
  available?(snapshot: AuthorizedSpaceSnapshot): boolean;
  activeWork?(): number;
  invoke(operation: SpaceOperation, request: { argv: readonly string[]; cwd: string; stdin?: string; signal: AbortSignal }): Promise<SpaceToolResult>;
  /** Profile-owned jobs/resources outlive a single invocation, but not their owner. */
  close?(): Promise<void>;
}
interface Ticket {
  directory: string;
  gate: SpaceOperationGate;
  operation: SpaceOperation;
  tools: ReadonlyMap<string, SpaceNativeTool>;
  controller: AbortController;
  active: number;
}

/** A native daemon may serve several scopes concurrently. Invocation authority
 * is bound to the originating turn, never to the daemon's first actor or env.
 * Each Space has its own endpoint; container mounts expose only that endpoint. */
export class SpaceNativeTools implements RunTools {
  private readonly tools = new Map<string, SpaceNativeTool>();
  private readonly tickets = new Map<string, Ticket>();
  private readonly ticketCleanup = new Set<Promise<void>>();
  private cleanupFailure: unknown;
  private readonly servers = new Map<string, Promise<{ server: Server; directory: string; socket: string }>>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly input: {
    authorization: SpaceAuthorization; directory: string; node: string;
    activeGate(): SpaceOperationGate;
    containerTransport?: boolean;
  }) {}

  register(tool: SpaceNativeTool): void {
    if (this.closed || !/^[a-z][a-z0-9-]{0,63}$/.test(tool.id) || !/^[a-f0-9]{64}$/.test(tool.authorityId)) throw new Error('invalid native tool');
    const key = JSON.stringify([tool.authorityId, tool.id]);
    if (this.tools.has(key)) throw new Error('native tool is already registered');
    this.tools.set(key, tool);
  }
  has(id: string, authorityId: string): boolean { return this.tools.has(JSON.stringify([authorityId, id])); }

  activeWork(): number {
    let count = 0;
    for (const tool of this.tools.values()) {
      try {
        const value = tool.activeWork?.() ?? 0;
        // Invalid adapter state must block a restart, not hide active work.
        count += Number.isSafeInteger(value) && value >= 0 ? value : 1;
      } catch { count++; }
    }
    return count;
  }

  async prepare(context: AuthorizedSpaceContext, _runId: string): Promise<RunToolLease | undefined> {
    if (this.closed) throw new Error('native tools are closed');
    const snapshot = this.input.authorization.inspect(context);
    const selected = new Map([...this.tools.values()].filter(tool => tool.authorityId === snapshot.principal.authorityId
      && (tool.available?.(snapshot) ?? true)).map(tool => [tool.id, tool]));
    if (!selected.size) return undefined;
    const gate = this.input.activeGate();
    const operation = gate.active();
    if (operation.context !== context || gate.services.authorization !== this.input.authorization) throw new Error('native tools require the original source operation');
    await gate.refresh(operation);
    const paths = resolveSpacePaths(this.input.directory, snapshot.binding.key);
    await prepareSpacePaths(paths);
    const entry = await assertConfinedPath(paths.tools, join(paths.tools, 'invoke.mjs'));
    const endpoint = await this.endpoint(snapshot.binding.key);
    const socket = endpoint.target;
    if (this.closed) throw new Error('native tools are closed');
    // Publish the current endpoint atomically with the existing host-generated
    // client. No task ticket is stored here; old commands keep their authority.
    await writeFileAtomic(entry, `const socketPath = ${JSON.stringify(socket)};\n${NATIVE_TOOL_CLIENT}`, { mode: 0o600 });
    if (this.closed) throw new Error('native tools are closed');
    if (this.tickets.size >= 1024) throw new Error('native tool run capacity reached');
    const token = randomBytes(32).toString('hex');
    const directory = await mkdtemp(join(paths.home, '.aria-ticket-'));
    const ticketFile = join(directory, 'authority');
    try {
      await writeFileAtomic(ticketFile, token, { mode: 0o600 });
      await gate.refresh(operation);
      if (this.closed) throw new Error('native tools are closed');
      if (this.tickets.size >= 1024) throw new Error('native tool run capacity reached');
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    const ticket: Ticket = { directory, gate, operation, tools: selected, controller: new AbortController(), active: 0 };
    this.tickets.set(token, ticket);
    const command = [this.input.node, entry, '--current', ticketFile].map(quote).join(' ');
    const prompt = ['当前请求的工具入口如下。客户端从本轮私有文件读取调用凭据，命令行不携带凭据值；地址由客户端自动选择；必须使用本轮入口，不得复用历史入口或转述凭据文件内容。',
      ...[...selected.values()].map(tool => `${tool.id}: ${command} ${quote(tool.id)} <原命令参数>\n${tool.description}`)].join('\n');
    return { prompt, close: () => this.revoke(token) };
  }

  private revoke(token: string): void {
    const ticket = this.tickets.get(token);
    this.tickets.delete(token);
    ticket?.controller.abort(new Error('native tool run ended'));
    if (ticket) {
      const cleanup = rm(ticket.directory, { recursive: true, force: true })
        .catch(error => { this.cleanupFailure ??= error; })
        .finally(() => this.ticketCleanup.delete(cleanup));
      this.ticketCleanup.add(cleanup);
    }
  }
  /** Trusted runtime composition only; not an agent-accessible management API. */
  async endpoint(key: SpaceKey): Promise<{ source: string; target: string }> {
    if (this.closed) throw new Error('native tools are closed');
    const id = spaceId(key);
    let pending = this.servers.get(id);
    if (!pending) { pending = this.start(id); this.servers.set(id, pending); }
    const { socket } = await pending;
    if (this.closed) throw new Error('native tools are closed');
    return { source: socket, target: this.input.containerTransport
      ? '/run/aria/native-tools.sock' : socket };
  }
  private async start(expectedSpace: string) {
    const directory = await mkdtemp(join(tmpdir(), 'aria-tools-'));
    await chmod(directory, 0o700);
    const socket = join(directory, 'rpc.sock');
    const server = createServer((request, response) => {
      const abort = new AbortController();
      response.once('close', () => { if (!response.writableEnded) abort.abort(); });
      const respond = (status: number, result: SpaceToolResult) => {
        if (response.destroyed) return;
        response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify(result));
      };
      void (async () => {
        if (this.closed || request.method !== 'POST' || request.url !== '/invoke') throw new Error('native tool endpoint unavailable');
        const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
        if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid native tool authority');
        const ticket = this.tickets.get(token);
        if (!ticket || ticket.active >= 4) throw new Error('native tool authority expired or capacity reached');
        const owner = this.input.authorization.inspect(ticket.operation.context);
        if (owner.binding.spaceId !== expectedSpace) throw new Error('native tool authority belongs to another Space');
        ticket.active++;
        try {
          const signal = AbortSignal.any([abort.signal, ticket.controller.signal, AbortSignal.timeout(70_000)]);
          const chunks: Buffer[] = []; let bytes = 0;
          for await (const chunk of request) {
            signal.throwIfAborted(); bytes += chunk.length;
            if (bytes > 1024 * 1024) throw new Error('native tool request too large');
            chunks.push(Buffer.from(chunk));
          }
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tool?: string; argv?: string[]; cwd?: string; stdin?: string };
          const tool = typeof value.tool === 'string' ? ticket.tools.get(value.tool) : undefined;
          if (!tool || !Array.isArray(value.argv) || value.argv.length > 512
            || value.argv.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 256 * 1024)
            || typeof value.cwd !== 'string' || (value.stdin !== undefined && typeof value.stdin !== 'string')
            || Object.keys(value).some(key => !['tool', 'argv', 'cwd', 'stdin'].includes(key))) throw new Error('invalid native tool request');
          signal.throwIfAborted();
          await ticket.gate.refresh(ticket.operation);
          const snapshot = this.input.authorization.inspect(ticket.operation.context);
          const paths = resolveSpacePaths(this.input.directory, snapshot.binding.key);
          await assertConfinedPath(paths.engine, value.cwd);
          const result = await ticket.gate.run(ticket.operation, () => tool.invoke(ticket.operation, {
            argv: value.argv!, cwd: value.cwd!, stdin: value.stdin, signal,
          }));
          signal.throwIfAborted();
          if (this.tickets.get(token) !== ticket) throw new Error('native tool authority ended');
          await ticket.gate.refresh(ticket.operation);
          respond(200, result);
        } finally { ticket.active--; }
      })().catch(error => respond(403, { stdout: '', stderr: error instanceof Error ? error.message : 'native tool failed', exitCode: 1 }));
    });
    server.requestTimeout = 70_000; server.headersTimeout = 10_000; server.maxConnections = 128;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socket, () => { server.removeListener('error', reject); resolve(); });
      });
      await chmod(socket, 0o600);
    } catch (error) { server.close(); await rm(directory, { recursive: true, force: true }); throw error; }
    return { server, socket, directory };
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      for (const token of this.tickets.keys()) this.revoke(token);
      const closed = await Promise.allSettled([...this.tools.values()].map(tool => tool.close?.()));
      this.tools.clear();
      const failure = closed.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      // Finish IPC teardown even when an extension reports a shutdown failure.
      const endpoints = await Promise.allSettled([...this.servers.values()].map(async pending => {
        const started = await pending.catch(() => undefined);
        if (!started) return;
        const { server, directory } = started;
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        await rm(directory, { recursive: true, force: true });
      }));
      this.servers.clear();
      await Promise.all(this.ticketCleanup);
      if (failure) throw failure.reason;
      const endpointFailure = endpoints.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (endpointFailure) throw endpointFailure.reason;
      if (this.cleanupFailure) throw this.cleanupFailure;
    })();
    return this.closing;
  }
}

function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
// Minimal protocol client, containing no host credentials or source selectors.
const NATIVE_TOOL_CLIENT = `import http from 'node:http';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
// The first argument is --current, or an obsolete socket in historical commands.
// Never connect to that caller-selected address or fall back to it on failure.
const [endpoint, ticketFile, tool, ...argv] = process.argv.slice(2);
if (!(endpoint === '--current' || (endpoint?.startsWith('/') && endpoint.endsWith('/rpc.sock')))
  || !ticketFile?.startsWith('/') || !/^[a-z][a-z0-9-]{0,63}$/.test(tool ?? '')) {
  process.stderr.write('invalid native tool invocation; use the current task command');
  process.exit(1);
}
let token;
try {
  const file = await open(ticketFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== 64 || (stat.mode & 0o077)) throw new Error('not private');
    token = await file.readFile('utf8');
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('invalid ticket');
  } finally { await file.close(); }
} catch {
  process.stderr.write('native tool authority expired or unavailable; use the current task entry');
  process.exit(1);
}
let stdin;
if (argv[0] === '--input-stdin') {
  argv.shift(); const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 512 * 1024) throw new Error('tool input too large'); chunks.push(chunk); }
  stdin = Buffer.concat(chunks).toString('utf8');
}
const body = JSON.stringify({ tool, argv, cwd: process.cwd(), stdin });
const req = http.request({ socketPath, path: '/invoke', method: 'POST', headers: {
  authorization: 'Bearer ' + token, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body)
}}, response => {
  let body = ''; let size = 0; response.setEncoding('utf8');
  response.on('data', chunk => { size += chunk.length; if (size > 17 * 1024 * 1024) req.destroy(new Error('tool result too large')); else body += chunk; });
  response.on('end', () => { try { const result = JSON.parse(body); process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exitCode = result.exitCode ?? 1; } catch { process.stderr.write('invalid tool response'); process.exitCode = 1; } });
});
req.setTimeout(75000, () => req.destroy(new Error('tool request timed out')));
req.on('error', error => { process.stderr.write('native tool transport failed (' + (error.code || 'transport_error') + '); no automatic retry; verify the current task entry and service status'); process.exitCode = 1; });
req.end(body);
`;
