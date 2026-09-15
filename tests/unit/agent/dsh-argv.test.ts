import { describe, expect, it } from 'vitest';
import { buildDshArgs } from '../../../src/agent/engines/dsh/argv.js';

describe('dsh argv contract', () => {
  it('loads the progress patch while keeping the prompt as the task positional', () => {
    expect(buildDshArgs('run tests', '/state/progress.json')).toEqual(['--profile', 'headless', '--patch', '/state/progress.json', 'run tests']);
  });
});
