export interface BuildPiArgsInput {
  sessionId?: string;
  model?: string;
  thinking?: string;
  approve?: boolean;
  sessionDir?: string;
}

/**
 * Flags only. The prompt travels on stdin: this engine declares
 * `promptInjection: 'stdin-prefix'`, and on Windows every npm-installed CLI is
 * reached through `cmd.exe`, which drops everything after the first newline of
 * an argument. ARIA-PI-001.
 */
export function buildPiArgs(input: BuildPiArgsInput): string[] {
  const args = ['-p', '--mode', 'json'];
  if (input.sessionId) args.push('--session', input.sessionId);
  if (input.model) args.push('--model', input.model);
  if (input.thinking && input.thinking !== 'default') {
    args.push('--thinking', input.thinking);
  }
  if (input.approve === true) args.push('--approve');
  if (input.sessionDir) args.push('--session-dir', input.sessionDir);
  return args;
}
