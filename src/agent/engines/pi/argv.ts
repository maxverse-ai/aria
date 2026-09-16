export interface BuildPiArgsInput {
  prompt: string;
  sessionId?: string;
  model?: string;
  thinking?: string;
  approve?: boolean;
  sessionDir?: string;
}

export function buildPiArgs(input: BuildPiArgsInput): string[] {
  const args = ['-p', '--mode', 'json'];
  if (input.sessionId) args.push('--session', input.sessionId);
  if (input.model) args.push('--model', input.model);
  if (input.thinking && input.thinking !== 'default') {
    args.push('--thinking', input.thinking);
  }
  if (input.approve === true) args.push('--approve');
  if (input.sessionDir) args.push('--session-dir', input.sessionDir);
  args.push(input.prompt);
  return args;
}

/**
 * Whether Windows can deliver this prompt as a single argv element.
 *
 * `buildPiArgs` puts the whole prompt — including the multi-line bridge system
 * prompt — in argv. On Windows every non-`.exe` command is reached through
 * `cmd.exe`, which drops everything after the first newline of an argument and
 * still exits 0. Verified against a real `.cmd` shim: the child received
 * `ARGS=[-p line1]` for a two-line prompt.
 *
 * A truncated prompt is worse than a refused one, so the adapter stops instead
 * of running the engine on a partial system prompt.
 */
export function piPromptCannotTravelInArgv(
  platform: string,
  binary: string,
  prompt: string,
): boolean {
  if (platform !== 'win32') return false;
  if (!prompt.includes('\n')) return false;
  return !/\.(?:exe|com)$/i.test(binary);
}
