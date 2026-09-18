import { mkdtemp, rm, writeFile, readFile, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { PreparedSpaceProfile } from '../../../src/space/profile';
import { SpaceOperationGate } from '../../../src/space/operation-gate';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import { larkSpaceNativeTool } from '../../../src/lark-cli/space-tool';
import type { SpaceToolCredentialProvider } from '../../../src/space/tool-credentials';
import { authorityId } from '../../../src/space/identity';
import { digest } from '../../../src/space/deployment';
import { nodeHelperBinary, runtimeProbeVersion } from '../../helpers/runtime';

const cleanups: Array<() => Promise<unknown>> = [];
// This fixture observes on the real clock. No case here asserts that a lease
// expires, so the lease only has to outlive the slowest host the suite runs on;
// a tight one turns a loaded machine into "space binding is stale or suspended".
const OBSERVATION_LEASE_MS = 60 * 60_000;
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(withExtension = false, existingRoot?: string, userAuthorization = false, driver: 'trusted-process' | 'execution' = 'trusted-process') {
  const root = existingRoot ?? await mkdtemp(join(tmpdir(), 'aria-native-tools-'));
  if (!existingRoot) cleanups.push(() => rm(root, { recursive: true, force: true }));
  const profile = createDefaultProfileConfig({ agentKind: 'claude', mode: 'team', accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } } });
  const sourceDefinition = { profileId: 'p', providerId: 'fixture', accountId: 'account', instanceId: 'source' };
  const module = join(root, 'extension.mjs');
  const sourceCode = `import {writeFile} from 'node:fs/promises';
export const spaceToolRevision='v1';
export function createSpaceTool(host) {return {id:'example', authorityId:host.authorityId, description:'Example scoped tool', activeWork:()=>2,
 async invoke(operation) { const gate=host.activeGate(); await gate.refresh(operation); const s=gate.services.authorization.inspect(operation.context);
 return {stdout:JSON.stringify({actor:s.principal.subjectId,space:s.binding.spaceId}),stderr:'',exitCode:0}; },
 async close(){await writeFile(host.directory+'/extension.closed','closed');}};}`;
  if (withExtension) await writeFile(module, sourceCode, { mode: 0o600 });
  const entry = '# Public tools\n';
  const spaces = await PreparedSpaceProfile.create({ profileId: 'p', profile, directory: root,
    ...(withExtension ? { workspaces: { schema: 'aria.space.workspaces.v1' as const,
      bundles: [{ id: 'public', revision: 'v1', entry: 'AGENTS.md', files: [{ path: 'AGENTS.md', contents: entry, sha256: digest(entry) }],
        skills: [], resources: [], requiresTools: [{ id: 'example', revision: 'v1' }] }], assignments: [],
      common: [{ kind: 'user' as const, authorityId: authorityId(sourceDefinition), bundles: ['public'] }],
      extensions: [{ id: 'example', revision: 'v1', module, sha256: digest(sourceCode) }] } } : {}),
    deployment: { engineId: 'claude', binary: process.execPath, binaryVersion: runtimeProbeVersion, queryNode: nodeHelperBinary,
      tools: { larkCli: { binary: process.execPath, binaryVersion: runtimeProbeVersion, userAuthorization } },
      launch: { driver, workspaceAccess: 'workspace', executableRoots: [], environment: {} } } });
  cleanups.push(() => spaces.services.close());
  const source = spaces.services.authorization.registerSource(sourceDefinition);
  let admitted = true, shared = false, revision = existingRoot ? 10_000 : 100;
  const gate = new SpaceOperationGate(spaces.services, { contractVersion: 1, invalidate: () => {},
    observe: async request => source.observe({ conversationId: request.conversationId, actorId: request.senderId,
      actorKind: request.senderKind, kind: request.kind, selfId: 'bot', authenticated: true, complete: true,
      humans: shared && request.kind === 'group' ? ['a', 'b'] : [request.senderId], agents: ['bot'],
      revision: ++revision, observedAt: Date.now(), expiresAt: Date.now() + OBSERVATION_LEASE_MS }) }, spaces.grants,
    () => ({ admitted, accessCeiling: 'workspace' }), Date.now, spaces.resources);
  await spaces.registerGate({ pluginId: 'fixture', instanceId: 'source', authorityId: source.authorityId }, gate);
  const provider: SpaceToolCredentialProvider = {
    id: 'lark', authorityId: source.authorityId,
    begin: vi.fn(async () => ({ verificationUrl: 'https://auth.example/verify', expiresAt: Date.now() + 30_000 })),
    complete: vi.fn(async input => ({ principal: input.context.principal, credentialRef: 'host-only-secret' })),
    cancel: vi.fn(async () => {}), revoke: vi.fn(async () => {}),
    invoke: vi.fn(async input => ({ stdout: input.identity + ':' + input.context.principal.subjectId, stderr: '', exitCode: 0 })),
  };
  spaces.tools.register(provider);
  spaces.nativeTools!.register(larkSpaceNativeTool({ authorityId: source.authorityId, credentials: spaces.tools, userAuthorization }));
  const enter = (user: string, group = false, conversation = (group ? 'group-' : 'dm-') + user) => gate.enter({ conversationId: conversation,
    senderId: user, senderKind: 'user', kind: group ? 'group' : 'direct' }, conversation);
  const open = async (user: string, group = false, conversation?: string) => {
    const operation = await enter(user, group, conversation);
    const lease = (await gate.run(operation, () => spaces.services.runTools.prepare(operation.context, user)))!;
    const command = lease.prompt.split('\n').find(line => line.startsWith('lark-cli:'))!;
    const parts = [...command.matchAll(/'([^']*)'/g)].map(match => match[1]!);
    const state = await spaces.services.state.view(operation.context);
    const client = await readFile(parts[1]!, 'utf8');
    const socket: string = JSON.parse(client.split('\n')[0]!.slice('const socketPath = '.length, -1));
    const token = await readFile(parts[3]!, 'utf8');
    const invoke = (argv: string[]) => call(socket, token, { tool: 'lark-cli', argv, cwd: state.paths.workspace });
    return { operation, lease, parts, token, socket, state, invoke };
  };
  return { root, spaces, gate, source, provider, open, enter, deny: () => { admitted = false; }, share: () => { shared = true; } };
}

function call(socketPath: string, token: string, value: unknown): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path: '/invoke', method: 'POST', headers: { authorization: 'Bearer ' + token } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => { try { resolve(JSON.parse(body)); } catch (error) { reject(error); } });
    });
    req.once('error', reject); req.end(JSON.stringify(value));
  });
}

it('native CLI calls retain each concurrent actor and reject ambient authority, foreign paths and ended run tickets', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.open('a'), f.open('b')]);
  expect((await a.invoke(['docs', 'list'])).stdout).toBe('bot:a');
  expect((await b.invoke(['docs', 'list'])).stdout).toBe('bot:b');
  expect((await call(a.socket, a.token, { tool: 'lark-cli', argv: ['docs', 'list'], cwd: b.state.paths.workspace })).exitCode).toBe(1);
  expect((await call(a.socket, '0'.repeat(64), {})).exitCode).toBe(1);
  expect(a.socket).not.toBe(b.socket);
  expect(a.lease.prompt).not.toContain(a.token);
  expect(a.parts.join(' ')).not.toContain(a.token);
  expect((await call(b.socket, a.token, { tool: 'lark-cli', argv: ['docs', 'list'], cwd: a.state.paths.workspace })).stderr).toContain('another Space');
  const native = await new Promise<{ stdout: string; exitCode: number | null }>((resolve, reject) => {
    const child = spawn(a.parts[0]!, [...a.parts.slice(1), 'auth', 'status', '--json'], { cwd: a.state.paths.workspace, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.once('error', reject);
    child.once('close', exitCode => resolve({ stdout, exitCode }));
  });
  expect(native.exitCode).toBe(0); expect(JSON.parse(native.stdout).identity).toBe('bot');
  a.lease.close();
  expect((await a.invoke(['docs', 'list'])).exitCode).toBe(1);
  expect((await b.invoke(['docs', 'list'])).exitCode).toBe(0);
});

it('the actual native OAuth entry refuses solo-group and same-request completion; a later DM activates only its own grant', async () => {
  const f = await fixture(false, undefined, true);
  const solo = await f.open('a', true), a = await f.open('a'), b = await f.open('b');
  const start = ['auth', 'login', '--no-wait', '--json', '--scope', 'docs:read'];
  expect((await solo.invoke(start)).exitCode).toBe(1);
  expect(f.provider.begin).not.toHaveBeenCalled();
  const result = JSON.parse((await a.invoke(start)).stdout);
  expect(result.verification_url).toBe('https://auth.example/verify');
  const complete = ['auth', 'login', '--device-code', result.device_code, '--json'];
  expect((await a.invoke(complete)).stderr).toContain('later user request');
  expect((await solo.invoke(complete)).exitCode).toBe(1);
  expect((await b.invoke(complete)).exitCode).toBe(1);
  expect(f.provider.complete).not.toHaveBeenCalled();
  a.lease.close(); const returned = await f.open('a');
  expect((await returned.invoke(complete)).exitCode).toBe(0);
  expect((await solo.invoke(['docs', 'list'])).stdout).toBe('user:a');
  expect((await b.invoke(['docs', 'list'])).stderr).toContain('owning user authorization');
  expect((await returned.invoke(['docs', 'list', '--as', 'bot'])).stderr).toContain('bot business identity is disabled');
  expect(returned.lease.prompt).not.toContain('host-only-secret');
  f.share(); const sharedA = await f.open('a', true, 'team'), sharedB = await f.open('b', true, 'team');
  expect((await sharedA.invoke(['docs', 'list'])).stdout).toBe('bot:a');
  expect((await sharedB.invoke(['docs', 'list'])).stdout).toBe('bot:b');
  expect((await sharedA.invoke(['docs', 'list', '--as', 'user'])).exitCode).toBe(1);
  expect(JSON.parse((await sharedA.invoke(['auth', 'status', '--json'])).stdout).identity).toBe('bot');
  expect((await sharedA.invoke(start)).exitCode).toBe(1);
  expect((await returned.invoke(['docs', 'list'])).stdout).toBe('user:a');

});

it('membership changes and revocation suppress already-running private output and cancel the provider', async () => {
  const f = await fixture(), a = await f.open('a', true);
  let release!: () => void;
  vi.mocked(f.provider.invoke).mockImplementationOnce(async input => {
    await new Promise<void>(resolve => { release = resolve; });
    return { stdout: input.signal.aborted ? 'cancelled-secret' : 'private-secret', stderr: '', exitCode: 0 };
  });
  const pending = a.invoke(['docs', 'list']);
  await vi.waitFor(() => expect(f.provider.invoke).toHaveBeenCalled());
  a.lease.close(); release();
  const result = await pending;
  expect(result.exitCode).toBe(1); expect(result.stdout).toBe('');
  const next = await f.open('a', true);
  f.share(); expect((await next.invoke(['docs', 'list'])).exitCode).toBe(1);
  const b = await f.open('b'); f.deny(); expect((await b.invoke(['docs', 'list'])).exitCode).toBe(1);
});

it('a native capability cannot be issued outside its authenticated operation or for another operation', async () => {
  const f = await fixture();
  const a = await f.enter('a'), b = await f.enter('b');
  await expect(f.spaces.services.runTools.prepare(a.context, 'ambient')).rejects.toThrow('authenticated');
  await expect(f.gate.run(a, () => f.spaces.services.runTools.prepare(b.context, 'foreign'))).rejects.toThrow('original source');
  await f.spaces.services.close();
  await expect(f.spaces.services.runTools.prepare(a.context, 'closed')).rejects.toThrow('closed');
});

it('a deployment extension uses the same fenced transport, matching Space selection and profile lifecycle', async () => {
  const f = await fixture(true);
  expect(f.spaces.services.runTools.activeWork?.()).toBe(2);
  f.spaces.nativeTools!.register({ id: 'invalid-count', authorityId: f.source.authorityId, description: 'test',
    invoke: async () => ({ stdout: '', stderr: '', exitCode: 0 }), activeWork: () => NaN });
  expect(f.spaces.services.runTools.activeWork?.()).toBe(3);
  const a = await f.open('a'), b = await f.open('new-user');
  for (const [actor, caller] of [['a', a], ['new-user', b]] as const) {
    expect(caller.lease.prompt).toContain('example:');
    const result = await call(caller.socket, caller.token, { tool: 'example', argv: [], cwd: caller.state.paths.workspace });
    expect(JSON.parse(result.stdout)).toEqual({ actor, space: f.spaces.services.authorization.inspect(caller.operation.context).binding.spaceId });
  }
  f.share(); const shared = await f.open('a', true);
  expect(shared.lease.prompt).not.toContain('example:');
  expect((await call(shared.socket, shared.token, { tool: 'example', argv: [], cwd: shared.state.paths.workspace })).exitCode).toBe(1);
  a.lease.close();
  expect((await call(a.socket, a.token, { tool: 'example', argv: [], cwd: a.state.paths.workspace })).stdout).toBe('');
  await f.spaces.services.close();
  expect(await readFile(join(f.root, 'extension.closed'), 'utf8')).toBe('closed');
});

async function runClient(parts: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
    const child = spawn(parts[0]!, parts.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', exitCode => resolve({ stdout, stderr, exitCode }));
  });
}

it('historical endpoints never receive a ticket; current tickets retain actor and cwd fences', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.open('a'), f.open('b')]);
  const obsolete = join(f.root, 'rpc.sock');
  const received = vi.fn();
  const trap = createServer((_req, res) => { received(); res.end('{}'); });
  await new Promise<void>(resolve => trap.listen(obsolete, resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => trap.close(error => error ? reject(error) : resolve())));
  const oldCommand = (parts: string[]) => [...parts.slice(0, 2), obsolete, ...parts.slice(3), 'docs', 'list'];
  for (const caller of [a, b]) {
    expect(caller.parts[2]).toBe('--current');
    expect(caller.lease.prompt).not.toContain(caller.socket);
  }
  const [ra, rb] = await Promise.all([
    runClient(oldCommand(a.parts), a.state.paths.workspace), runClient(oldCommand(b.parts), b.state.paths.workspace),
  ]);
  expect(ra).toMatchObject({ exitCode: 0, stdout: 'bot:a' });
  expect(rb).toMatchObject({ exitCode: 0, stdout: 'bot:b' });
  expect((await runClient(oldCommand(a.parts), b.state.paths.workspace)).exitCode).toBe(1);
  a.lease.close();
  expect((await runClient(oldCommand(a.parts), a.state.paths.workspace)).stderr).toContain('authority expired');
  await f.spaces.services.close();
  expect((await runClient(oldCommand(b.parts), b.state.paths.workspace)).stderr).toContain('authority expired');
  await expect(readFile(b.parts[3]!)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(received).not.toHaveBeenCalled();
});

it('service recreation refreshes the same client path without renewing historical task authority', async () => {
  const before = await fixture(), old = await before.open('a');
  await before.spaces.services.close();
  const after = await fixture(false, before.root), current = await after.open('a');
  expect(current.parts[1]).toBe(old.parts[1]);
  expect(current.socket).not.toBe(old.socket);
  const historical = [old.parts[0]!, old.parts[1]!, old.socket, old.parts[3]!, 'lark-cli', 'docs', 'list'];
  expect((await runClient(historical, current.state.paths.workspace)).stderr).toContain('authority expired');
  historical[3] = current.parts[3]!;
  expect(await runClient(historical, current.state.paths.workspace)).toMatchObject({ exitCode: 0, stdout: 'bot:a' });
  expect(await runClient([...current.parts, 'docs', 'list'], current.state.paths.workspace)).toMatchObject({ exitCode: 0, stdout: 'bot:a' });
  await after.spaces.services.close();
  const failed = await runClient(historical, current.state.paths.workspace);
  expect(failed.exitCode).toBe(1);
  expect(failed.stderr).toContain('authority expired');
  expect(failed.stderr).not.toContain(current.parts[3]);
});

it('rejects public or symlinked ticket files before contacting a tool', async () => {
  const f = await fixture(); const caller = await f.open('a');
  const command = [...caller.parts, 'docs', 'list'];
  await chmod(caller.parts[3]!, 0o644);
  expect((await runClient(command, caller.state.paths.workspace)).stderr).toContain('authority expired');
  await chmod(caller.parts[3]!, 0o600);
  const alias = join(caller.state.paths.home, 'ticket-alias');
  await symlink(caller.parts[3]!, alias);
  command[3] = alias;
  expect((await runClient(command, caller.state.paths.workspace)).stderr).toContain('authority expired');
  expect(f.provider.invoke).not.toHaveBeenCalled();
});

 it('shares a bot endpoint within the team Space while keeping separate task tickets', async () => {
  const f = await fixture(); f.share();
  const a = await f.open('a', true, 'same-team');
  const b = await f.open('b', true, 'same-team');
  const aSpace = f.spaces.services.authorization.inspect(a.operation.context).binding.spaceId;
  expect(f.spaces.services.authorization.inspect(b.operation.context).binding.spaceId).toBe(aSpace);
  expect(a.state.paths.workspace).toBe(b.state.paths.workspace);
  expect(a.socket).toBe(b.socket);
  expect(a.parts[1]).toBe(b.parts[1]);
  expect(a.parts[3]).not.toBe(b.parts[3]);
  expect((await call(b.socket, a.token, { tool: 'lark-cli', argv: ['docs','list'], cwd: a.state.paths.workspace })).stdout).toBe('bot:a');
  expect((await a.invoke(['docs','list'])).stdout).toBe('bot:a');
  expect((await b.invoke(['docs','list'])).stdout).toBe('bot:b');
});

it('registers and closes the same owned extension on an execution deployment', async () => {
  const f = await fixture(true, undefined, false, 'execution');
  expect(f.spaces.nativeTools!.has('example', f.source.authorityId)).toBe(true);
  await f.spaces.services.close();
  expect(await readFile(join(f.root, 'extension.closed'), 'utf8')).toBe('closed');
});
