// Historical counterexample evidence, deliberately separate from passing production model gates.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedResult, verifyJar } from '../../check.mjs';

const jar = process.env.TLA2TOOLS_JAR;
if (!jar) throw new Error('Set TLA2TOOLS_JAR to the pinned official jar.');
verifyJar(readFileSync(jar));
const directory = fileURLToPath(new URL('.', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'aria-audit-20261109-'));
try {
  for (const [model, property] of [
    ['ResultCheckpoint', 'RecoverableOutput'],
    ['DeliveryClaim', 'SingleDispatch'],
    ['RunningRecovery', 'RecoveryCanAdvance'],
    ['PrepareCancel', 'SafeSubmission'],
    ['StaleUpdateLock', 'SingleUpdater'],
    ['KeystoreWrites', 'NoLostCompletedWrite'],
    ['NoticeFallback', 'NoDuplicate'],
  ]) {
    const result = spawnSync(process.env.JAVA ?? 'java', ['-Xmx512m', '-XX:+UseParallelGC', '-cp', resolve(jar),
      'tlc2.TLC', '-workers', '1', '-metadir', join(temporary, model), '-config', `${model}.cfg`, `${model}.tla`],
    { cwd: directory, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    process.stdout.write((result.stdout ?? '') + (result.stderr ?? ''));
    if (!expectedResult(result, property)) throw new Error(`Expected counterexample absent: ${model}/${property}`);
  }
  const guarded = spawnSync(process.env.JAVA ?? 'java', ['-Xmx512m', '-XX:+UseParallelGC', '-cp', resolve(jar),
    'tlc2.TLC', '-workers', '1', '-metadir', join(temporary, 'guarded'),
    '-config', 'PrepareCancelGuarded.cfg', 'PrepareCancel.tla'],
  { cwd: directory, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  process.stdout.write((guarded.stdout ?? '') + (guarded.stderr ?? ''));
  if (!expectedResult(guarded)) throw new Error('Guarded reference did not complete successfully');
} finally { rmSync(temporary, { recursive: true, force: true }); }
