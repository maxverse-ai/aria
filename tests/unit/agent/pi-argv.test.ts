import { describe, expect, it } from 'vitest';
import { buildPiArgs, piPromptCannotTravelInArgv } from '../../../src/agent/engines/pi/argv.js';

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

  describe('multi-line prompt transport', () => {
    const prompt = 'line one\nline two';

    it('is unaffected on POSIX hosts', () => {
      expect(piPromptCannotTravelInArgv('linux', '/usr/local/bin/pi', prompt)).toBe(false);
      expect(piPromptCannotTravelInArgv('darwin', '/usr/local/bin/pi', prompt)).toBe(false);
    });

    it('is unaffected through a native Windows executable', () => {
      expect(piPromptCannotTravelInArgv('win32', 'C:\\pi\\pi.exe', prompt)).toBe(false);
    });

    it('is unaffected by a single-line prompt', () => {
      expect(piPromptCannotTravelInArgv('win32', 'C:\\pi\\pi.cmd', 'one line')).toBe(false);
    });

    it('refuses a multi-line prompt through a Windows cmd shim', () => {
      // Verified against a real shim: cmd.exe delivered `ARGS=[-p line one]` and
      // exited 0, so the engine would have run on a truncated system prompt.
      expect(piPromptCannotTravelInArgv('win32', 'C:\\pi\\pi.cmd', prompt)).toBe(true);
      expect(piPromptCannotTravelInArgv('win32', 'C:\\pi\\pi.bat', prompt)).toBe(true);
      expect(piPromptCannotTravelInArgv('win32', 'C:\\pi\\pi', prompt)).toBe(true);
    });
  });
});
