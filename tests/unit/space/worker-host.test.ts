import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { gateFixture, directRequest } from '../../helpers/space-gate';
import { FakeAgentAdapter } from '../../helpers/fake-agent';
import { createAdapterRuntime } from '../../../src/agent/runtime/adapter-runtime';
import { createProfileConversationHost } from '../../../src/conversation/profile-host';
import { AriaWorkerServer } from '../../../src/worker/server';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
it('X2/D4: a normal account-free profile executes through the authenticated worker and fences reset/deduplication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-space-worker-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const agents: FakeAgentAdapter[] = [];
  const f = await gateFixture(root, { create: async () => {
    const agent = new FakeAgentAdapter({ id: 'claude', events: [
      { type: 'system', sessionId: 'session-' + agents.length }, { type: 'final_text', content: 'owned answer' },
      { type: 'done', terminationReason: 'normal' },
    ] }); agents.push(agent); return createAdapterRuntime(agent);
  } });
  cleanups.push(() => f.services.close());
  const configPath = join(root, 'config.json');
  const config = JSON.stringify({ schemaVersion: 3, profiles: { profile: { schemaVersion: 3, agentKind: 'claude', mode: 'team', channels: { plugins: [], instances: {} } } } });
  await writeFile(configPath, config);
  const host = await createProfileConversationHost({ configPath, profile: 'profile', stateDirectory: join(root, 'host'), spaces: f.services });
  cleanups.push(() => host.close());
  const a = await f.gate.enter(directRequest(), 'dm-a'); const b = await f.gate.enter(directRequest('b'), 'dm-b');
  await expect(host.runText({ scopeId: 'dm-a', actorId: 'a', prompt: 'spoof', authorized: true })).rejects.toThrow('space');
  await expect(host.reset('dm-b', a.context)).rejects.toThrow('scope');
  await expect(host.run({ scopeId: 'dm-a', actorId: 'a', prompt: 'read host file', authorized: true, spaceContext: a.context,
    attachments: [{ kind: 'file', decision: 'accepted', requiredness: 'required', path: configPath }] })).rejects.toThrow('trusted source admission');
  await host.runText({ scopeId: 'dm-b', actorId: 'b', prompt: 'B work', authorized: true, spaceContext: b.context });
  const input = new PassThrough(); const output = new PassThrough(); const messages: any[] = [];
  let buffer = ''; output.on('data', chunk => { buffer += chunk.toString(); const lines = buffer.split('\n'); buffer = lines.pop()!; lines.filter(Boolean).forEach(line => messages.push(JSON.parse(line))); });
  expect(() => new AriaWorkerServer({ input, output, host, profile: 'profile', workerVersion: 'test' })).toThrow('authenticated');
  const server = new AriaWorkerServer({ input, output, host, profile: 'profile', workerVersion: 'test',
    spaceSession: { gate: f.gate, principal: f.authorization.inspect(a.context).principal,
      resolve: async scope => scope === 'dm-a' ? a : b } });
  const serving = server.serve(); cleanups.push(async () => { await server.stop(); await serving; });
  const send = (id: number, method: string, params?: unknown) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const params = { operationId: 'job', scopeRef: 'dm-a', actorRef: 'a', prompt: 'A work', authorization: { decision: 'allow', reference: 'untrusted-JSON' } };
  send(1, 'run.start', { ...params, actorRef: 'b' }); send(2, 'run.start', { ...params, scopeRef: 'dm-b', actorRef: 'b' });
  send(3, 'run.start', params);
  await vi.waitFor(() => expect(messages.some(m => m.method === 'run.completed')).toBe(true));
  expect(messages.find(m => m.id === 1).error).toBeDefined(); expect(messages.find(m => m.id === 2).error).toBeDefined();
  expect(messages.find(m => m.method === 'run.completed').params.content).toBe('owned answer');
  send(4, 'run.start', params); send(5, 'session.reset', { scopeRef: 'dm-b' }); send(6, 'session.reset', { scopeRef: 'dm-a' });
  send(7, 'runtime.shutdown');
  await vi.waitFor(() => expect(messages.some(m => m.id === 7)).toBe(true));
  expect(messages.find(m => m.id === 4).result.duplicate).toBe(true);
  expect(messages.find(m => m.id === 5).error).toBeDefined();
  expect(messages.find(m => m.id === 6).result.archivedSessionCount).toBeGreaterThan(0);
  expect(messages.find(m => m.id === 7).error).toBeDefined();
  expect(agents.reduce((n, agent) => n + agent.runOptions.length, 0)).toBe(2);
  expect((await f.services.state.view(b.context)).sessionCatalog.entries().length).toBeGreaterThan(0);
  expect(await readFile(configPath, 'utf8')).toBe(config);
});
