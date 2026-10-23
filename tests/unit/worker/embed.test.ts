import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { defineEngineRuntimeDescriptor } from '../../../src/agent/runtime/types';
import type { ProfileConversationHost } from '../../../src/conversation/profile-host';

const { createProfileConversationHost } = vi.hoisted(() => ({
  createProfileConversationHost: vi.fn(),
}));

vi.mock('../../../src/conversation/profile-host', () => ({ createProfileConversationHost }));

const dirs: string[] = [];

afterEach(async () => {
  createProfileConversationHost.mockReset();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

it('composes a named product worker without exposing Aria profile internals', async () => {
  const { createAriaWorker } = await import('../../../src/worker/embed');
  const root = await mkdtemp(join(tmpdir(), 'aria-embed-'));
  dirs.push(root);
  const host: ProfileConversationHost = {
    descriptor: defineEngineRuntimeDescriptor({ engineId: 'codex', topology: 'session-pool' }),
    run: async () => ({ ok: true, runId: 'run', content: '' }),
    runText: async () => ({ ok: true, runId: 'run', content: '' }),
    interrupt: async () => false,
    reset: async () => ({ interrupted: false, archivedSessionCount: 0 }),
    close: vi.fn(async () => undefined),
  };
  createProfileConversationHost.mockResolvedValue(host);

  const worker = await createAriaWorker({
    configPath: join(root, 'config.json'),
    profile: 'riff-computer',
    stateDirectory: join(root, 'instance', 'worker'),
    input: new PassThrough(),
    output: new PassThrough(),
    productIdentity: { id: 'riff-computer', displayName: 'Riff Computer' },
  });

  expect(createProfileConversationHost).toHaveBeenCalledWith({
    configPath: resolve(root, 'config.json'),
    profile: 'riff-computer',
    stateDirectory: resolve(root, 'instance', 'worker'),
  });
  expect(worker.serve).toBeTypeOf('function');
  expect(worker.stop).toBeTypeOf('function');
  await worker.stop();
});

it('requires an explicit isolated profile and state directory', async () => {
  const { createAriaWorker } = await import('../../../src/worker/embed');
  await expect(createAriaWorker({
    configPath: '', profile: '', stateDirectory: '', input: new PassThrough(), output: new PassThrough(),
  })).rejects.toThrow('configPath, profile and stateDirectory are required');
});

it('rejects invalid product metadata before creating the host', async () => {
  const { createAriaWorker } = await import('../../../src/worker/embed');
  await expect(createAriaWorker({
    configPath: 'unused.json', profile: 'local', stateDirectory: 'unused',
    input: new PassThrough(), output: new PassThrough(),
    productIdentity: { id: '../escape', displayName: 'Riff Computer' },
  })).rejects.toThrow('lowercase kebab-case');
  expect(createProfileConversationHost).not.toHaveBeenCalled();
});

it('rejects an inherited standalone Aria environment before creating the host', async () => {
  const { createAriaWorker } = await import('../../../src/worker/embed');
  vi.stubEnv('ARIA_HOME', 'standalone-aria');
  await expect(createAriaWorker({
    configPath: 'unused.json', profile: 'local', stateDirectory: 'unused',
    input: new PassThrough(), output: new PassThrough(),
  })).rejects.toThrow('isolated environment');
  expect(createProfileConversationHost).not.toHaveBeenCalled();
});
