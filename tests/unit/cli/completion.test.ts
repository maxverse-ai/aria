import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { emitCompletion } from '../../../src/cli/completion';
import { positiveIntOption } from '../../../src/cli/parse';

function fixture(): Command {
  const program = new Command();
  program.name('aria').option('--verbose', 'verbose output');
  program
    .command('profile')
    .description('Manage profiles')
    .command('show')
    .description('Show a profile')
    .option('--json', 'print JSON');
  program.command('hidden-cmd', { hidden: true }).description('machine-facing');
  return program;
}

describe('emitCompletion', () => {
  it.each(['bash', 'zsh', 'fish'] as const)('emits a %s script covering visible commands only', (shell) => {
    const script = emitCompletion(fixture(), shell);
    expect(script).toContain('profile');
    expect(script).toContain('show');
    expect(script).toContain('json');
    expect(script).not.toContain('hidden-cmd');
  });

  it('emits bash associative-array entries keyed by command path', () => {
    const script = emitCompletion(fixture(), 'bash');
    expect(script).toContain('declare -A _aria_words');
    expect(script).toContain('"profile show"');
    expect(script).toContain('complete -F _aria aria');
  });

  it('emits a zsh compdef header', () => {
    expect(emitCompletion(fixture(), 'zsh')).toContain('#compdef aria');
  });

  it('emits fish complete rules', () => {
    const script = emitCompletion(fixture(), 'fish');
    expect(script).toContain('complete -c aria -f');
    expect(script).toContain("__fish_seen_subcommand_from profile");
  });
});

describe('positiveIntOption', () => {
  it('returns the fallback when the flag is absent', () => {
    expect(positiveIntOption(undefined, '--hours', 24)).toBe(24);
  });

  it('parses decimal integers', () => {
    expect(positiveIntOption('48', '--hours', 24)).toBe(48);
  });

  it.each(['0', '-3', '1.5', 'abc', '1e3', ''])('rejects %j', (raw) => {
    expect(() => positiveIntOption(raw, '--count', 5)).toThrow('--count must be a positive integer');
  });
});
