import { createDistributionRuntime } from '../../composition/distribution';

export interface UpdateOutputOptions {
  json?: boolean;
}

export async function runUpdateCheck(options: UpdateOutputOptions = {}): Promise<void> {
  const { service } = await createDistributionRuntime();
  const result = await service.check();
  if (options.json) return printJson(result);
  if (!result.latest) {
    console.log('没有可用的完整、不可变内部版本。');
    return;
  }
  const current = result.current ? `${result.current.version} (${shortSha(result.current.commit)})` : '未托管';
  console.log(`当前版本: ${current}`);
  console.log(`最新版本: ${result.latest.version} (${shortSha(result.latest.commit)})`);
  console.log(result.updateAvailable ? '可更新。运行 `aria update plan` 创建更新计划。' : '已经是最新版本。');
}

export async function runUpdatePlan(
  options: UpdateOutputOptions & { version?: string; force?: boolean } = {},
): Promise<void> {
  const { service } = await createDistributionRuntime();
  const plan = await service.createPlan({ version: options.version, force: options.force });
  if (options.json) return printJson(plan);
  console.log(`✓ 更新计划已创建: ${plan.id}`);
  console.log(`  目标: ${plan.target.version} (${shortSha(plan.target.commit)})`);
  console.log(`  校验: SHA-256 ${plan.target.sha256}`);
  console.log(`  到期: ${plan.expiresAt}`);
  console.log(`  应用: aria update apply ${plan.id}`);
}

export async function runUpdateApply(
  planId: string,
  options: UpdateOutputOptions & { foreground?: boolean } = {},
): Promise<void> {
  const { service, executor } = await createDistributionRuntime();
  if (options.foreground) {
    const operation = await service.apply(planId);
    if (options.json) return printJson(operation);
    console.log(`✓ Aria 已更新到 ${operation.installed?.version ?? '目标版本'}。`);
    return;
  }
  const result = await executor.execute(planId);
  if (options.json) return printJson(result);
  console.log(`✓ 更新已交给独立执行器: ${result.operationId}`);
  console.log(`  状态: aria update status ${result.operationId}`);
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

function shortSha(commit: string): string {
  return commit === '0'.repeat(40) ? 'legacy' : commit.slice(0, 12);
}
