import { createDistributionRuntime } from '../composition/distribution';

interface UpdaterArgs {
  planId?: string;
  operationId: string;
  rollback: boolean;
  force: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { service } = await createDistributionRuntime({ includeLegacyCurrent: false });
  if (args.rollback) {
    await service.rollback(args.force, args.operationId);
    return;
  }
  if (!args.planId) throw new Error('--plan-id is required');
  await service.apply(args.planId, args.operationId);
}

function parseArgs(argv: string[]): UpdaterArgs {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const operationId = value('--operation-id');
  if (!operationId) throw new Error('--operation-id is required');
  return {
    planId: value('--plan-id'),
    operationId,
    rollback: argv.includes('--rollback'),
    force: argv.includes('--force'),
  };
}

main().catch((err: unknown) => {
  process.stderr.write(`Aria updater failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
