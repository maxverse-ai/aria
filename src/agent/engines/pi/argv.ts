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
