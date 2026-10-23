import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverInstalledAgents } from '../../../src/worker/installed-agents';
import { resolveExecutablePath } from '../../../src/platform/executable';

vi.mock('../../../src/platform/executable', () => ({ resolveExecutablePath: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe('discoverInstalledAgents', () => {
  it('uses plugin command names without starting agents or claiming authentication', async () => {
    vi.mocked(resolveExecutablePath).mockImplementation(async (command) => {
      if (command === 'codex') return '/installed/codex';
      if (command === 'dsh') throw Object.assign(new Error('private path'), { code: 'EACCES' });
      throw new Error('private path');
    });
    expect(await discoverInstalledAgents()).toEqual([
      { id: 'codex', displayName: 'Codex CLI', status: 'installed', binaryPath: '/installed/codex' },
      { id: 'claude', displayName: 'Claude Code', status: 'notInstalled' },
      { id: 'dsh', displayName: 'DeepSeek Harness', status: 'unavailable' },
    ]);
    expect(vi.mocked(resolveExecutablePath).mock.calls).toEqual([['codex'], ['claude'], ['dsh']]);
  });
});
