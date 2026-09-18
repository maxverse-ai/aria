import { access } from 'node:fs/promises';
import type {
  DetachedUpdateExecutor,
  DistributionRepository,
  UpdateOperationV1,
} from '../../application/distribution/types';
import { UPDATE_OPERATION_SCHEMA_VERSION } from '../../application/distribution/types';
import { currentRuntime } from '../runtime';
import { spawnProcess } from '../spawn';
import type { CommandRunner } from './command-runner';
import { ProcessCommandRunner } from './command-runner';

export class OsDetachedUpdateExecutor implements DetachedUpdateExecutor {
  constructor(
    private readonly store: DistributionRepository,
    private readonly updaterEntry: string,
    private readonly runner: CommandRunner = new ProcessCommandRunner(),
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly runtimePath = currentRuntime.execPath,
    private readonly now: () => Date = () => new Date(),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async execute(planId: string): Promise<{ operationId: string; detached: boolean }> {
    const plan = await this.store.readPlan(planId);
    const operationId = this.store.newId('op');
    const operation = this.scheduled(operationId, {
      operation: 'update',
      planId,
      target: { kind: 'release', release: plan.target },
    });
    await this.store.writeOperation(operation);
    try {
      await this.launch(['--plan-id', planId, '--operation-id', operationId], operationId);
    } catch (err) {
      await this.markLaunchFailed(operation, err);
      throw err;
    }
    return { operationId, detached: true };
  }

  async executeRollback(force: boolean): Promise<{ operationId: string; detached: boolean }> {
    const operationId = this.store.newId('op');
    const state = await this.store.readState();
    if (!state.current || !state.previous) throw new Error('no previous Aria version is available for rollback');
    const operation = this.scheduled(operationId, {
      operation: 'rollback',
      planId: null,
      target: { kind: 'installed', version: state.previous },
    });
    operation.previous = state.current;
    operation.installed = state.previous;
    await this.store.writeOperation(operation);
    const args = ['--rollback', '--operation-id', operationId];
    if (force) args.push('--force');
    try {
      await this.launch(args, operationId);
    } catch (err) {
      await this.markLaunchFailed(operation, err);
      throw err;
    }
    return { operationId, detached: true };
  }

  private async launch(args: string[], operationId: string): Promise<void> {
    await access(this.updaterEntry);
    const updaterArgs = [this.updaterEntry, ...args];
    const label = `aria-update-${operationId}`;
    if (this.platform === 'linux') {
      // `systemd-run --user` starts from the user manager's environment, not
      // the invoking CLI's environment. Forward only the non-secret gh config
      // directory so private-release revalidation uses the same isolated
      // identity without exposing GH_TOKEN in unit metadata or process args.
      const githubConfig = this.env.GH_CONFIG_DIR;
      await this.runner.run('systemd-run', [
        '--user',
        '--collect',
        '--quiet',
        '--unit', label,
        '--property=Type=exec',
        ...(githubConfig ? [`--setenv=GH_CONFIG_DIR=${githubConfig}`] : []),
        this.runtimePath,
        ...updaterArgs,
      ]);
      return;
    }
    if (this.platform === 'darwin') {
      await this.runner.run('launchctl', [
        'submit', '-l', `ai.maxverse.${label}`, '--', this.runtimePath, ...updaterArgs,
      ]);
      return;
    }
    if (this.platform === 'win32') {
      const child = spawnProcess(this.runtimePath, updaterArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return;
    }
    throw new Error(`detached Aria updates are unsupported on ${this.platform}; use --foreground`);
  }

  private scheduled(
    id: string,
    input: Pick<UpdateOperationV1, 'operation' | 'planId' | 'target'>,
  ): UpdateOperationV1 {
    const timestamp = this.now().toISOString();
    return {
      schemaVersion: UPDATE_OPERATION_SCHEMA_VERSION,
      id,
      ...input,
      status: 'planned',
      startedAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      previous: null,
      installed: null,
      error: null,
    };
  }

  private async markLaunchFailed(operation: UpdateOperationV1, err: unknown): Promise<void> {
    const timestamp = this.now().toISOString();
    operation.status = 'failed';
    operation.updatedAt = timestamp;
    operation.completedAt = timestamp;
    operation.error = {
      code: 'DETACHED_EXECUTOR_FAILED',
      message: err instanceof Error ? err.message : String(err),
    };
    await this.store.writeOperation(operation);
  }
}
