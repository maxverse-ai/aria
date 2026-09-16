import { describe, expect, it } from 'vitest';
import { buildPiArgs } from '../../../src/agent/engines/pi/argv.js';

describe('pi argv contract', () => {
  it('builds a non-interactive json run', () => {
    expect(buildPiArgs({})).toEqual([
      '-p',
      '--mode',
      'json',
    ]);
  });

  it('adds session, model, thinking, approve and session dir', () => {
    expect(
      buildPiArgs({
        sessionId: 'ses-1',
        model: 'anthropic/claude-sonnet-4-6',
        thinking: 'high',
        approve: true,
        sessionDir: '/tmp/pi-sessions',
      }),
    ).toEqual([
      '-p',
      '--mode',
      'json',
      '--session',
      'ses-1',
      '--model',
      'anthropic/claude-sonnet-4-6',
      '--thinking',
      'high',
      '--approve',
      '--session-dir',
      '/tmp/pi-sessions',
    ]);
  });

  it('never puts a prompt in argv, so a shell cannot truncate one', () => {
    const args = buildPiArgs({ sessionId: 'ses-1', model: 'm', thinking: 'high' });
    expect(args.every((arg) => !arg.includes('\n'))).toBe(true);
  });
});
