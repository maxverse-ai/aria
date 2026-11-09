// Run from the repository root. Only synthetic data and controlled transports are used.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsup'))('esbuild');
mkdirSync('scripts/audit-control', { recursive: true });
for (const name of ['runtime', 'delivery']) {
  const outfile = resolve(`scripts/audit/${name}.mjs`);
  await build({ entryPoints: [`tools/formal/audits/2026-11-09/${name}.probe-source.ts`],
    outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
  const result = spawnSync(process.execPath, [outfile], { encoding: 'utf8', timeout: 30000 });
  process.stdout.write((result.stdout ?? '') + (result.stderr ?? ''));
  if (result.error || result.status !== 0) throw new Error(`${name} probe failed`, { cause: result.error });
}
for (const name of ['lock-probe', 'keystore-deterministic', 'health-probe']) {
  const result = spawnSync(process.execPath, [`tools/formal/audits/2026-11-09/${name}.mjs`],
    { encoding: 'utf8', timeout: 30000 });
  process.stdout.write((result.stdout ?? '') + (result.stderr ?? ''));
  if (result.error || result.status !== 0) throw new Error(`${name} failed`, { cause: result.error });
}
