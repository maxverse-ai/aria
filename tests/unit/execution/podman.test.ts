import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { CodexAppServerClient, type AppServerChild } from '../../../src/agent/engines/codex/app-server/client';
import { describe, expect, it, vi } from 'vitest';
import { PodmanExecutionBackend, type PodmanConfiguration } from '../../../src/execution/podman';
import type { ExecutionEnvironmentSpec } from '../../../src/execution/types';
import type { ExecutionOwnership, ExecutionOwnerRecord } from '../../../src/execution/ownership';
const config: PodmanConfiguration = { binary: '/usr/bin/podman', image: 'registry.example/agent@sha256:' + 'a'.repeat(64),
  user: '1000:1000', network: 'none', memoryBytes: 256 * 1024 * 1024, cpus: 1, pids: 64,
  tmpBytes: 16 * 1024 * 1024, managerCwd: '/manager', managerEnv: { HOME: '/manager', PATH: '/usr/bin' } };
const spec = (key = 'b'.repeat(64)): ExecutionEnvironmentSpec => ({ key, revision: 'v1', cwd: '/work', workingRoots: ['/work'],
  mounts: [{ source: '/private/' + key, target: '/work', writable: true }] });
function fixture() {
  const records = new Map<string, ExecutionOwnerRecord>();
  const held = new Set<string>();
  const ownership: ExecutionOwnership = { async acquire(key) {
    if (held.has(key)) throw new Error('another manager owns the Space');
    held.add(key);
    return { get healthy() { return held.has(key); }, async read() { return records.get(key); },
      async write(record) { records.set(key, record); }, async release() { held.delete(key); } };
  } };
  const containers = new Map<string, { Config: { Labels: Record<string, string> }; State: { Running: boolean } }>();
  const run = vi.fn(async (args: readonly string[]) => {
    if (args[0] === 'container') return { code: containers.has(args[2]!) ? 0 : 1, stdout: '' };
    if (args[0] === 'create') {
      const labels: Record<string, string> = {};
      args.forEach((arg, index) => { if (arg === '--label') { const [key, value] = args[index + 1]!.split('='); labels[key!] = value!; } });
      containers.set(args[args.indexOf('--name') + 1]!, { Config: { Labels: labels }, State: { Running: false } });
    }
    if (args[0] === 'rm') containers.delete(args[1]!);
    if (args[0] === 'inspect') return { code: 0, stdout: JSON.stringify([containers.get(args[1]!)]) };
    if (args[0] === 'start') containers.get(args[1]!)!.State.Running = true;
    if (args[0] === 'stop') containers.get(args.at(-1)!)!.State.Running = false;
    return { code: 0, stdout: '' };
  });
  return { run, containers, ownership, loseOwnership: () => held.clear(),
    backend: new PodmanExecutionBackend(config, run, ownership) };
}
describe('Podman execution adapter', () => {
  it('keeps a Space usable after a successful Codex metadata probe closes stdin', async () => {
    const f = fixture(); const env = await f.backend.open(spec());
    const child = new ChildProcess();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const kill = vi.fn(() => true); child.kill = kill;
    child.stdin.once('finish', () => {
      Object.defineProperty(child, 'exitCode', { value: 0 }); child.emit('exit', 0, null);
    });
    env.prepare({ command: '/bin/codex', args: ['app-server'], cwd: '/work', env: {} }).onSpawn!(child);
    const client = new CodexAppServerClient(child as AppServerChild);
    await client.dispose(10);
    expect(child.exitCode).toBe(0);
    expect(kill).not.toHaveBeenCalled();
    expect(env.isUsable!()).toBe(true);
    expect(f.run.mock.calls.filter(([args]) => args[0] === 'stop')).toHaveLength(0);
    expect(() => env.prepare({ command: '/bin/codex', args: ['app-server'], cwd: '/work', env: {} })).not.toThrow();
    await env.close();
  });

  it('still fences a Codex probe that ignores graceful shutdown', async () => {
    const f = fixture(); const env = await f.backend.open(spec());
    const child = new ChildProcess();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const kill = vi.fn(() => true); child.kill = kill;
    env.prepare({ command: '/bin/codex', args: ['app-server'], cwd: '/work', env: {} }).onSpawn!(child);
    const client = new CodexAppServerClient(child as AppServerChild);
    await client.dispose(10);
    expect(child.stdin.writableEnded).toBe(true);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    expect(env.isUsable!()).toBe(false);
    await env.close();
  });

  it('recreates a stopped container when trusted deployment network intent changes', async () => {
    const f = fixture();
    const isolated = await f.backend.open(spec());
    await isolated.close();
    const connected = new PodmanExecutionBackend({ ...config, network: 'bridge' }, f.run, f.ownership);
    const environment = await connected.open(spec());
    const creates = f.run.mock.calls.filter(([args]) => args[0] === 'create');
    expect(creates).toHaveLength(2);
    expect(creates[0]![0]).toContain('--network=none');
    expect(creates[1]![0]).toContain('--network=bridge');
    expect(creates[1]![0]).toContain('--cap-drop=ALL');
    expect(creates[1]![0]).not.toContain('--privileged');
    expect(f.run.mock.calls.filter(([args]) => args[0] === 'rm')).toHaveLength(1);
    await environment.close();
  });

  it('does not hand out an environment when ownership disappears during readiness', async () => {
    const f = fixture(); const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async args => {
      const result = await original(args);
      if (args[0] === 'exec') f.loseOwnership();
      return result;
    });
    await expect(f.backend.open(spec())).rejects.toThrow('cleanup requires recovery');
    // A stale manager must not stop a container now potentially owned elsewhere.
    expect(f.run.mock.calls.some(([args]) => args[0] === 'stop')).toBe(false);
    await expect(f.backend.open(spec())).rejects.toThrow('already acquired');
  });
  it('keeps one acquired instance per Space and reuses stopped storage without deleting it', async () => {
    const f = fixture(); const env = await f.backend.open(spec());
    await expect(f.backend.open(spec())).rejects.toThrow('already acquired');
    const other = await f.backend.open(spec('c'.repeat(64)));
    expect(env.id).not.toBe(other.id);
    await env.close(); await env.close();
    const resumed = await f.backend.open(spec());
    expect(resumed.id).toBe(env.id);
    expect(f.run.mock.calls.filter(([args]) => args[0] === 'create')).toHaveLength(2);
    expect(f.run.mock.calls.some(([args]) => args[0] === 'rm')).toBe(false);
    await resumed.close(); await other.close();
  });
  it('separates manager environment from task configuration and does not expose values in argv', async () => {
    const f = fixture(); const env = await f.backend.open(spec());
    const prepared = env.prepare({ command: '/usr/bin/node', args: ['-e', 'literal'], cwd: '/work',
      env: { HOME: '/work/home', TOKEN: 'secret value;$(do-not-execute)' } });
    expect(prepared.env.HOME).toBe('/manager');
    expect(prepared.args.join(' ')).not.toContain('secret value');
    expect(prepared.env.ARIA_EXEC_VALUE_1).toBe('secret value;$(do-not-execute)');
    expect(() => env.prepare({ command: '/bin/true', args: [], cwd: '/other', env: {} })).toThrow('escapes');
    await env.close();
    expect(() => env.prepare({ command: '/bin/true', args: [], cwd: '/work', env: {} })).toThrow('closed');
  });
  it('recovers only journal-owned generations and rejects foreign-owned containers', async () => {
    const f = fixture(); const env = await f.backend.open(spec()); await env.close();
    const next = new PodmanExecutionBackend(config, f.run, f.ownership);
    const replacement = await next.open({ ...spec(), revision: 'changed' });
    await replacement.close();
    expect(replacement.id).toBe(env.id);
    expect(f.run.mock.calls.filter(([args]) => args[0] === 'rm')).toHaveLength(1);
    f.containers.get(env.id)!.State.Running = true;
    const recovered = await next.open({ ...spec(), revision: 'changed' });
    expect(f.run.mock.calls.filter(([args]) => args[0] === 'stop')).toHaveLength(3);
    await recovered.close();
    f.containers.get(env.id)!.State.Running = false;
    f.containers.get(env.id)!.Config.Labels['io.aria.execution.owner'] = 'foreign';
    await expect(next.open(spec())).rejects.toThrow('owner differs');
    expect(f.run.mock.calls.filter(([args]) => args[0] === 'rm')).toHaveLength(1);
  });
  it('rejects a second manager while the first holds the Space, and rejects an unjournaled generation', async () => {
    const f = fixture(); const env = await f.backend.open(spec());
    const next = new PodmanExecutionBackend(config, f.run, f.ownership);
    await expect(next.open(spec())).rejects.toThrow('another manager');
    await env.close();
    f.containers.get(env.id)!.Config.Labels['io.aria.execution.generation'] = 'unknown';
    await expect(next.open(spec())).rejects.toThrow('generation');
    expect(f.run.mock.calls.filter(([args]) => args[0] === 'stop')).toHaveLength(1);
  });
  it('uses read-only images, explicit limits and no network or privileged mode', async () => {
    const f = fixture(); const env = await f.backend.open(spec());
    const args = f.run.mock.calls.find(([args]) => args[0] === 'create')![0];
    for (const option of ['--pull=never', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--network=none', '--memory', '--cpus', '--pids-limit']) expect(args).toContain(option);
    expect(args).not.toContain('--privileged');
    const entrypoint = args.indexOf('--entrypoint');
    expect(args.slice(entrypoint, entrypoint + 6)).toEqual([
      '--entrypoint', '/bin/sh', config.image, '-c',
      'trap "exit 0" TERM INT; while :; do sleep 2147483647 & wait $!; done', 'aria-space-holder',
    ]);
    await env.close();
  });
  it('does not release ownership when stop reports success but the container is still running', async () => {
    const f = fixture(); const env = await f.backend.open(spec());
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async args => args[0] === 'stop' ? { code: 0, stdout: '' } : original(args));
    await expect(env.close()).rejects.toThrow('stop could not be verified');
    await expect(f.backend.open(spec())).rejects.toThrow('already acquired');
    expect(() => env.prepare({ command: '/bin/true', args: [], cwd: '/work', env: {} })).toThrow('closed');
  });
  it('stops an instance when readiness fails before handing it to an engine', async () => {
    const f = fixture(); const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async args => args[0] === 'exec' ? { code: 125, stdout: '' } : original(args));
    await expect(f.backend.open(spec())).rejects.toThrow('operation failed');
    expect([...f.containers.values()].every(record => !record.State.Running)).toBe(true);
    f.run.mockImplementation(original);
    const recovered = await f.backend.open(spec()); await recovered.close();
  });
  it('rejects an already cancelled acquisition before touching the runtime', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.backend.open(spec(), controller.signal)).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });
  it('fences a killed exec client immediately and verifies cleanup independently', async () => {
    const f = fixture(); const env = await f.backend.open(spec());
    const request = env.prepare({ command: '/bin/true', args: [], cwd: '/work', env: {} });
    const child = new ChildProcess(); child.kill = vi.fn(() => true);
    request.onSpawn!(child);
    child.kill(0); expect(env.isUsable!()).toBe(true);
    child.kill('SIGKILL'); expect(env.isUsable!()).toBe(false);
    await env.close();
    expect(f.containers.get(env.id)!.State.Running).toBe(false);
  });
  it('retires failed synchronous probes and asynchronously crashed clients', async () => {
    const f = fixture(); const first = await f.backend.open(spec());
    const probe = first.prepare({ command: '/bin/true', args: [], cwd: '/work', env: {} });
    probe.onSyncExit!({ pid: 1, output: [], stdout: '', stderr: '', status: null, signal: 'SIGTERM' });
    expect(first.isUsable!()).toBe(false); await first.close();
    const second = await f.backend.open(spec());
    const child = new ChildProcess();
    second.prepare({ command: '/bin/true', args: [], cwd: '/work', env: {} }).onSpawn!(child);
    child.emit('exit', 125, null);
    expect(second.isUsable!()).toBe(false); await second.close();
  });
  it('retains its fence when startup cleanup fails', async () => {
    const f = fixture();
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation(async args => ['start', 'stop'].includes(args[0]!) ? { code: 125, stdout: '' } : original(args));
    await expect(f.backend.open(spec())).rejects.toThrow('cleanup requires recovery');
    await expect(f.backend.open(spec())).rejects.toThrow('already acquired');
  });
});
