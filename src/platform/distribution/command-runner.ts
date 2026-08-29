import { spawnProcess } from '../spawn';

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: { cwd?: string }): Promise<CommandResult>;
}

export class ProcessCommandRunner implements CommandRunner {
  async run(command: string, args: readonly string[], options: { cwd?: string } = {}): Promise<CommandResult> {
    return await new Promise((resolve, reject) => {
      const child = spawnProcess(command, args, {
        cwd: options.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
      child.once('error', (err) => reject(commandError(command, args, stderr, err)));
      child.once('close', (code, signal) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(commandError(command, args, stderr, new Error(`exit ${code ?? signal ?? 'unknown'}`)));
      });
    });
  }
}

function commandError(command: string, args: readonly string[], stderr: string, cause: Error): Error {
  const detail = stderr.trim() || cause.message;
  return new Error(`${command} ${args.join(' ')} failed: ${detail}`, { cause });
}
