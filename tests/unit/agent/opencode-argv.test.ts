import { describe, expect, it } from 'vitest';
import { buildOpenCodeArgs } from '../../../src/agent/engines/opencode/argv.js';

describe('OpenCode argv contract', () => {
  it('builds a fresh JSON run with the target directory', () => {
    expect(buildOpenCodeArgs({ cwd: '/repo' })).toEqual([
      'run',
      '--format',
      'json',
      '--dir',
      '/repo',
    ]);
  });

  it('adds session, model, agent and auto-approve flags when configured', () => {
    expect(
      buildOpenCodeArgs({
        cwd: '/repo',
        sessionId: 'ses_1',
        model: 'anthropic/claude-sonnet-4-6',
        agent: 'build',
        autoApprove: true,
      }),
    ).toEqual([
      'run',
      '--session',
      'ses_1',
      '--model',
      'anthropic/claude-sonnet-4-6',
      '--agent',
      'build',
      '--auto',
      '--format',
      'json',
      '--dir',
      '/repo',
    ]);
  });

  it('omits --auto unless explicitly enabled', () => {
    expect(buildOpenCodeArgs({ cwd: '/repo' })).not.toContain('--auto');
  });

  it('honours a fork-specific auto-approve flag', () => {
    expect(
      buildOpenCodeArgs({
        cwd: '/repo',
        autoApprove: true,
        autoApproveFlag: '--dangerously-skip-permissions',
      }),
    ).toEqual([
      'run',
      '--dangerously-skip-permissions',
      '--format',
      'json',
      '--dir',
      '/repo',
    ]);
  });
});
