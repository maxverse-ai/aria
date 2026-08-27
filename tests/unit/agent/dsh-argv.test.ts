import { describe, expect, it } from 'vitest';
import { buildDshArgs } from '../../../src/agent/engines/dsh/argv.js';

describe('dsh argv contract', () => {
  it('boots the headless profile with the prompt as the task positional', () => {
    expect(buildDshArgs('run tests')).toEqual(['--profile', 'headless', 'run tests']);
  });
});
