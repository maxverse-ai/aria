import { createDistributionRuntime } from '../composition/distribution';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node aria-install.mjs [--version x.y.z] [--force]');
    console.log('Installs Aria from a complete immutable private GitHub Release using gh authentication.');
    return;
  }
  const versionIndex = args.indexOf('--version');
  const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined;
  if (versionIndex >= 0 && !version) throw new Error('--version requires x.y.z');
  // Adopt a legacy npm/pnpm global command when present so existing services
  // can be rewritten to the stable launcher and still roll back safely.
  const { service, paths } = await createDistributionRuntime({ includeLegacyCurrent: true });
  console.log('Resolving and verifying the private Aria release...');
  const plan = await service.createPlan({ version, force: args.includes('--force') });
  console.log(`Installing Aria ${plan.target.version}...`);
  await service.apply(plan.id);
  console.log(`✓ Aria ${plan.target.version} installed.`);
  console.log(`  Command: ${paths.commandFile}`);
  if (!process.env.PATH?.split(process.platform === 'win32' ? ';' : ':').includes(paths.binRoot)) {
    console.log(`  Add this directory to PATH: ${paths.binRoot}`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Aria installation failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
