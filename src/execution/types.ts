import type { ChildProcess, SpawnOptions, SpawnSyncOptions, SpawnSyncReturns } from 'node:child_process';

/** Trusted deployment intent; never constructed from model tool arguments. */
export interface ExecutionEnvironmentSpec {
  readonly key: string;
  readonly revision: string;
  readonly mounts: readonly { source: string; target: string; writable: boolean }[];
  readonly workingRoots: readonly string[];
  readonly cwd: string;
}
export interface ExecutionCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}
export interface ExecutionSpawn extends ExecutionProcessHooks {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}
export interface ExecutionProcessHooks {
  /** Observe the actual client so abnormal exit cannot leave an environment reusable. */
  onSpawn?(child: ChildProcess): void;
  onSyncExit?(result: SpawnSyncReturns<Buffer | string>): void;
}
/** An acquired environment belongs to one Space until close finishes. */
export interface ExecutionEnvironment {
  readonly id: string;
  isUsable?(): boolean;
  prepare(command: ExecutionCommand): ExecutionSpawn;
  close(): Promise<void>;
}
export interface ExecutionBackend {
  readonly id: string;
  open(spec: ExecutionEnvironmentSpec, signal?: AbortSignal): Promise<ExecutionEnvironment>;
}
export function applyExecutionSpawn<T extends SpawnOptions | SpawnSyncOptions>(environment: ExecutionEnvironment,
  command: ExecutionCommand, options: T): { command: string; args: readonly string[]; options: T } & ExecutionProcessHooks {
  const prepared = environment.prepare(command);
  return { command: prepared.command, args: prepared.args,
    onSpawn: prepared.onSpawn, onSyncExit: prepared.onSyncExit,
    options: { ...options, cwd: prepared.cwd, env: prepared.env, shell: false } };
}
