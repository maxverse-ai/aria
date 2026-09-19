import { createDistributionRuntime } from '../../composition/distribution';

export interface UpdateOutputOptions {
  json?: boolean;
}

export async function runUpdateCheck(options: UpdateOutputOptions = {}): Promise<void> {
  const { service } = await createDistributionRuntime();
  const result = await service.check();
  if (options.json) return printJson(result);
  if (!result.latest) {
    console.log('No complete, immutable internal release is available.');
    return;
  }
  const current = result.current ? `${result.current.version} (${shortSha(result.current.commit)})` : 'unmanaged';
  console.log(`current: ${current}`);
  console.log(`latest:  ${result.latest.version} (${shortSha(result.latest.commit)})`);
  console.log(result.updateAvailable
    ? 'Update available. Run `aria update plan` to create an update plan.'
    : 'Already on the latest version.');
}

export async function runUpdatePlan(
  options: UpdateOutputOptions & { version?: string; force?: boolean } = {},
): Promise<void> {
  const { service } = await createDistributionRuntime();
  const plan = await service.createPlan({ version: options.version, force: options.force });
  if (options.json) return printJson(plan);
  console.log(`✓ Update plan created: ${plan.id}`);
  console.log(`  target:  ${plan.target.version} (${shortSha(plan.target.commit)})`);
  console.log(`  sha256:  ${plan.target.sha256}`);
  console.log(`  expires: ${plan.expiresAt}`);
  console.log(`  apply:   aria update apply ${plan.id}`);
}

export async function runUpdatePlanShow(
  planId: string,
  options: UpdateOutputOptions = {},
): Promise<void> {
  const { service } = await createDistributionRuntime({ includeLegacyCurrent: false });
  const report = await service.planStatus(planId);
  if (options.json) return printJson(report);
  const { plan, state, operations } = report;
  console.log(`plan:    ${plan.id} (${state})`);
  console.log(`target:  ${plan.target.version} (${shortSha(plan.target.commit)})`);
  console.log(`sha256:  ${plan.target.sha256}`);
  console.log(`created: ${plan.createdAt}`);
  console.log(`expires: ${plan.expiresAt}`);
  if (plan.cancelledAt) console.log(`cancelled: ${plan.cancelledAt}`);
  if (operations.length === 0) {
    console.log(state === 'active'
      ? `apply:   aria update apply ${plan.id}`
      : 'operations: none');
  } else {
    console.log('operations:');
    for (const operation of operations) {
      console.log(`- ${operation.id} · ${operation.operation} · ${operation.status}`);
    }
  }
}

export async function runUpdateCancel(
  planId: string,
  options: UpdateOutputOptions = {},
): Promise<void> {
  const { service } = await createDistributionRuntime({ includeLegacyCurrent: false });
  const plan = await service.cancelPlan(planId);
  if (options.json) return printJson(plan);
  console.log(`✓ Update plan cancelled: ${plan.id} (cancelledAt ${plan.cancelledAt})`);
  console.log('  The plan file is kept as evidence; `aria update apply` will reject it.');
}

export async function runUpdateApply(
  planId: string,
  options: UpdateOutputOptions & { foreground?: boolean } = {},
): Promise<void> {
  const { service, executor } = await createDistributionRuntime();
  if (options.foreground) {
    const operation = await service.apply(planId);
    if (options.json) return printJson(operation);
    console.log(`✓ Aria updated to ${operation.installed?.version ?? 'the target version'}.`);
    return;
  }
  const result = await executor.execute(planId);
  if (options.json) return printJson(result);
  console.log(`✓ Update handed to the detached executor: ${result.operationId}`);
  console.log(`  status: aria update status ${result.operationId}`);
}

export async function runUpdateStatus(operationId: string | undefined, options: UpdateOutputOptions = {}): Promise<void> {
  const { service } = await createDistributionRuntime({ includeLegacyCurrent: false });
  const operation = await service.status(operationId);
  if (options.json) return printJson(operation ?? null);
  if (!operation) {
    console.log('No update or rollback operation has been recorded yet.');
    return;
  }
  console.log(`operation: ${operation.id} (${operation.operation})`);
  console.log(`status:    ${operation.status}`);
  if (operation.error) console.log(`error:     ${operation.error.message}`);
  if (operation.completedAt) console.log(`completed: ${operation.completedAt}`);
}

export async function runUpdateRollback(
  options: UpdateOutputOptions & { force?: boolean; foreground?: boolean } = {},
): Promise<void> {
  const { service, executor } = await createDistributionRuntime({ includeLegacyCurrent: false });
  if (options.foreground) {
    const operation = await service.rollback(options.force === true);
    if (options.json) return printJson(operation);
    console.log(`✓ Rolled back to ${operation.installed?.version ?? 'the previous version'}.`);
    return;
  }
  const result = await executor.executeRollback(options.force === true);
  if (options.json) return printJson(result);
  console.log(`✓ Rollback handed to the detached executor: ${result.operationId}`);
  console.log(`  status: aria update status ${result.operationId}`);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function shortSha(commit: string): string {
  return commit === '0'.repeat(40) ? 'legacy' : commit.slice(0, 12);
}
