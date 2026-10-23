import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createHost: vi.fn(),
  assertEnvironment: vi.fn(),
  configureLogger: vi.fn(),
}));

vi.mock('../../../src/conversation/profile-host', () => ({
  createProfileConversationHost: mocks.createHost,
}));
vi.mock('../../../src/worker/isolation', () => ({
  assertIsolatedWorkerEnvironment: mocks.assertEnvironment,
}));
vi.mock('../../../src/core/logger', () => ({ configureLogger: mocks.configureLogger }));

import { runWorker } from '../../../src/cli/commands/worker';

describe('worker CLI product identity', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { productId: 'riff-computer' },
    { productName: 'Riff Computer' },
    { productId: '', productName: 'Riff Computer' },
    { productId: '../riff', productName: 'Riff Computer' },
    { productId: 'riff-computer', productName: 'Riff\nComputer' },
  ])('rejects invalid identity before constructing any runtime: %j', async (identity) => {
    await expect(runWorker({
      config: 'unused.json', profile: 'local', stateDir: 'unused-state', ...identity,
    })).rejects.toThrow();
    expect(mocks.createHost).not.toHaveBeenCalled();
    expect(mocks.configureLogger).not.toHaveBeenCalled();
  });
});
