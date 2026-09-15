import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { PodmanExecutionBackend } from '../../../src/execution/podman';
import type { ExecutionEnvironment } from '../../../src/execution/types';

// Opt-in: use an isolated Podman store and a pre-pulled Alpine digest. The
// deterministic repository gate does not install runtimes or pull images.
const binary = process.env.ARIA_TEST_PODMAN_BINARY;
const image = process.env.ARIA_TEST_PODMAN_IMAGE;
it.skipIf(!binary || !image)('real rootless adapter preserves private mounts and quotas across idle restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-execution-proof-'));
  const key = createHash('sha256').update(randomUUID()).digest('hex');
  const managerEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([name, value]) => value !== undefined && ['HOME', 'PATH', 'XDG_RUNTIME_DIR'].includes(name))) as Record<string, string>;
  const backend = new PodmanExecutionBackend({ binary: binary!, image: image!, user: '10001:10001',
    network: 'none', memoryBytes: 64 * 1024 * 1024, cpus: 0.25, pids: 32, tmpBytes: 1024 * 1024,
    managerCwd: root, managerEnv });
  let environment: ExecutionEnvironment | undefined;
  let created = false;
  const execute = (script: string, args: string[] = []) => {
    const invocation = environment!.prepare({ command: '/bin/sh', args: ['-c', script, 'proof', ...args],
      cwd: '/work', env: { HOME: '/work', PATH: '/usr/bin:/bin' } });
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: invocation.cwd, env: invocation.env, encoding: 'utf8', timeout: 10_000 });
    invocation.onSyncExit?.(result);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  };
  try {
    await mkdir(join(root, 'a'), { mode: 0o700 });
    await mkdir(join(root, 'b'), { mode: 0o700 });
    await writeFile(join(root, 'b/private'), 'another Space', { mode: 0o600 });
    const spec = { key, revision: 'real-proof-v1', cwd: '/work', workingRoots: ['/work'],
      mounts: [{ source: join(root, 'a'), target: '/work', writable: true }] };
    environment = await backend.open(spec); created = true;
    expect(execute('id -u; cat /sys/fs/cgroup/cpu.max /sys/fs/cgroup/memory.max /sys/fs/cgroup/pids.max'))
      .toBe('10001\n25000 100000\n67108864\n32\n');
    execute('test ! -e "$1" && test ! -e /run/podman/podman.sock && echo durable > /work/output', [join(root, 'b/private')]);
    await environment.close(); environment = undefined;
    expect((await readFile(join(root, 'a/output'), 'utf8')).trim()).toBe('durable');
    environment = await backend.open(spec);
    expect(execute('cat /work/output').trim()).toBe('durable');
  } finally {
    // Never erase the backing data while stop has not been verified.
    if (environment) await environment.close();
    if (created) {
      const result = spawnSync(binary!, ['rm', 'aria-space-' + key], { env: managerEnv, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
    } else {
      const result = spawnSync(binary!, ['container', 'exists', 'aria-space-' + key], {
        env: managerEnv, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, 'Startup did not finish; preserve test data unless the instance is absent').toBe(1);
    }
    await rm(root, { recursive: true });
  }
}, 60_000);
