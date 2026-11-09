import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = process.env.TLA2TOOLS_JAR;
if (!jar) throw new Error('Set TLA2TOOLS_JAR to a local tla2tools.jar (tested with TLA+ 1.7.4).');
const directory = fileURLToPath(new URL('.', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'aria-codex-tlc-'));
try {
  for (const name of ['CodexResumeLegacy', 'CodexResume', 'CodexResumeConcurrent']) {
    const result = spawnSync(process.env.JAVA ?? 'java', [
      '-Xmx1g', '-XX:+UseParallelGC', '-cp', resolve(jar), 'tlc2.TLC', '-workers', '2',
      '-metadir', join(temporary, name), '-config', `${name}.cfg`, 'CodexResume.tla',
    ], { cwd: directory, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    process.stdout.write(output);
    const legacy = name === 'CodexResumeLegacy';
    if (result.error || (legacy
      ? result.status === 0 || !output.includes('Invariant SafeSubmission is violated.')
      : result.status !== 0 || !output.includes('Model checking completed. No error has been found.'))) {
      throw new Error(`${name} did not produce the expected ${legacy ? 'counterexample' : 'successful check'}`, { cause: result.error });
    }
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
