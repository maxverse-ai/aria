import { createDistributionRuntime } from '../../composition/distribution';

export interface UpdateOutputOptions {
  json?: boolean;
}

export async function runUpdateCheck(options: UpdateOutputOptions = {}): Promise<void> {
  throw externalUpdatesDisabled(options);
}

export async function runUpdatePlan(
  options: UpdateOutputOptions & { version?: string; force?: boolean } = {},
): Promise<void> {
  throw externalUpdatesDisabled(options);
}

export async function runUpdateApply(
  planId: string,
  options: UpdateOutputOptions & { foreground?: boolean } = {},
): Promise<void> {
  void planId;
  throw externalUpdatesDisabled(options);
}

export async function runUpdateStatus(operationId: string | undefined, options: UpdateOutputOptions = {}): Promise<void> {
  const { service } = await createDistributionRuntime({ includeLegacyCurrent: false });
  const operation = await service.status(operationId);
  if (options.json) return printJson(operation ?? null);
  if (!operation) {
    console.log('还没有更新或回滚记录。');
    return;
  }
  console.log(`操作: ${operation.id} (${operation.operation})`);
  console.log(`状态: ${operation.status}`);
  if (operation.error) console.log(`错误: ${operation.error.message}`);
  if (operation.completedAt) console.log(`完成: ${operation.completedAt}`);
}

export async function runUpdateRollback(
  options: UpdateOutputOptions & { force?: boolean; foreground?: boolean } = {},
): Promise<void> {
  const { service, executor } = await createDistributionRuntime({ includeLegacyCurrent: false });
  if (options.foreground) {
    const operation = await service.rollback(options.force === true);
    if (options.json) return printJson(operation);
    console.log(`✓ 已回滚到 ${operation.installed?.version ?? '上一版本'}。`);
    return;
  }
  const result = await executor.executeRollback(options.force === true);
  if (options.json) return printJson(result);
  console.log(`✓ 回滚已交给独立执行器: ${result.operationId}`);
  console.log(`  状态: aria update status ${result.operationId}`);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function externalUpdatesDisabled(options: UpdateOutputOptions): Error {
  const message = 'External updates are disabled for this local fork. Run `corepack pnpm local:rollout` from the canonical Aria main repository.';
  if (options.json) {
    return new Error(JSON.stringify({ code: 'EXTERNAL_UPDATES_DISABLED', message }));
  }
  return new Error(message);
}
