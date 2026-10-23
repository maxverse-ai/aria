import { describe, expect, it, vi } from 'vitest';
import { normalizeEngineProfileConfig } from '../../../src/config/profile-schema';
import { dshRuntimeFactory } from '../../../src/agent/engines/dsh/plugin';
import { claudeRuntimeFactory } from '../../../src/agent/engines/claude/plugin';
import { join } from 'node:path';

const captured = vi.hoisted(() => ({ dsh: vi.fn(), claude: vi.fn() }));
vi.mock('../../../src/agent/engines/dsh/adapter', () => ({
  DshAdapter: class { constructor(options: unknown) { captured.dsh(options); } id = 'dsh'; },
}));
vi.mock('../../../src/agent/claude/adapter', () => ({
  ClaudeAdapter: class { constructor(options: unknown) { captured.claude(options); } id = 'claude'; },
}));

describe('embedded engine user configuration', () => {
  it.each([
    [{}, join('/private-state', 'dsh-home')],
    [{ inheritDshHome: true }, undefined],
    [{ inheritDshHome: true, dshHome: '/explicit' }, '/explicit'],
  ])('resolves DSH home with explicit inheritance and override precedence', (options, expected) => {
    const profileConfig = normalizeEngineProfileConfig({ schemaVersion: 2, agentKind: 'dsh', dsh: { binaryPath: '/installed/dsh', ...options } });
    dshRuntimeFactory.createRuntime({ profileConfig, appPaths: { profileDir: '/private-state' } });
    expect(captured.dsh).toHaveBeenLastCalledWith(expect.objectContaining({ binary: '/installed/dsh', dshHome: expected }));
  });

  it('preserves a discovered Claude Code path through profile normalization', () => {
    const profileConfig = normalizeEngineProfileConfig({ schemaVersion: 2, agentKind: 'claude', claude: { binaryPath: '/installed/claude' } });
    claudeRuntimeFactory.createRuntime({ profileConfig, appPaths: { profileDir: '/private-state' } });
    expect(captured.claude).toHaveBeenLastCalledWith(expect.objectContaining({ binary: '/installed/claude' }));
  });
});
