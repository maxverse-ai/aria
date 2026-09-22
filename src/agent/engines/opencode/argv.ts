export interface BuildOpenCodeArgsInput {
  cwd: string;
  sessionId?: string;
  /** Forwarded to `opencode run --model` as `provider/model`. */
  model?: string;
  agent?: string;
  autoApprove?: boolean;
  /**
   * Flag appended when autoApprove is on. OpenCode uses `--auto`; forks may
   * rename it (MiMo-Code uses `--dangerously-skip-permissions`).
   */
  autoApproveFlag?: string;
}

export function buildOpenCodeArgs(input: BuildOpenCodeArgsInput): string[] {
  const args = ['run'];
  if (input.sessionId) args.push('--session', input.sessionId);
  if (input.model) args.push('--model', input.model);
  if (input.agent) args.push('--agent', input.agent);
  if (input.autoApprove === true) args.push(input.autoApproveFlag ?? '--auto');
  // The prompt is delivered on stdin; the trailing positionals stay empty so
  // opencode reads stdin as the message (and no XML ever reaches argv).
  args.push('--format', 'json', '--dir', input.cwd);
  return args;
}
