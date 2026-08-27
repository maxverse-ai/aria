import { describe, expect, it } from 'vitest';
import { buildPiArgs } from '../../../src/agent/engines/pi/argv.js';

describe('pi argv contract', () => {
  it('builds a non-interactive json run with the prompt', () => {
    expect(buildPiArgs({ prompt: 'run tests' })).toEqual([
      '-p',
      '--mode',
      'json',
      'run tests',
    ]);
  });

  it('adds session, model, thinking, approve and session dir', () => {
    expect(
      buildPiArgs({
        prompt: 'deep',
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
      'deep',
    ]);
  });
});
