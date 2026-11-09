import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
export const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));

export function selectGroups(ids) {
  if (!ids.length) return manifest.groups;
  for (const id of ids) {
    if (!manifest.groups.some(group => group.id === id)) throw new Error(`Unknown formal group: ${id}`);
  }
  return manifest.groups.filter(group => ids.includes(group.id));
}

export function expectedResult(result, violation) {
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  if (result.error || result.signal) return false;
  // TLC exit 12 means invariant violation. Tool errors must not satisfy a negative control.
  return violation
    ? result.status === 12 && output.includes(`Invariant ${violation} is violated.`)
    : result.status === 0 && output.includes('Model checking completed. No error has been found.');
}

export function verifyJar(bytes) {
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.toolchain.sha256) {
    throw new Error(`TLC checksum mismatch; use the official ${manifest.toolchain.release} asset from manifest.json`);
  }
}

export function run(ids = [], options = {}) {
  const groups = selectGroups(ids);
  const jar = process.env.TLA2TOOLS_JAR;
  if (!jar) throw new Error('Set TLA2TOOLS_JAR to the pinned official jar; see docs/FORMAL_VERIFICATION_POLICY.md');
  verifyJar(readFileSync(jar));
  const java = process.env.JAVA ?? 'java';
  const version = spawnSync(java, ['-version'], { encoding: 'utf8', timeout: 10000 });
  const major = Number(((version.stderr ?? '') + (version.stdout ?? '')).match(/version "(\d+)/)?.[1]);
  if (version.error || version.status !== 0 || !(major >= manifest.toolchain.javaMinimum)) {
    throw new Error(`Java ${manifest.toolchain.javaMinimum}+ required; set JAVA to its executable`);
  }
  const temporary = mkdtempSync(join(tmpdir(), 'aria-formal-'));
  const results = [];
  try {
    for (const group of groups) for (const test of group.cases) {
      writeFileSync(join(temporary, test.model), readFileSync(join(directory, test.model)));
      writeFileSync(join(temporary, `${test.name}.cfg`), test.config ?? readFileSync(join(directory, test.configFile)));
      const started = Date.now();
      const result = spawnSync(java, ['-Xmx1g', '-XX:+UseParallelGC', '-cp', resolve(jar), 'tlc2.TLC',
        '-workers', '1', '-metadir', join(temporary, `${test.name}-states`),
        '-config', `${test.name}.cfg`, test.model], {
        cwd: temporary, encoding: 'utf8', timeout: manifest.toolchain.timeoutMs, maxBuffer: 8 * 1024 * 1024,
      });
      const output = (result.stdout ?? '') + (result.stderr ?? '');
      const ok = expectedResult(result, test.violation);
      results.push({ group: group.id, case: test.name, ok, elapsedMs: Date.now() - started,
        expected: test.violation ? `counterexample: ${test.violation}` : 'complete check',
        exitCode: result.status, error: result.error?.message ?? null, output });
      console.log(`${ok ? 'PASS' : 'FAIL'} ${test.name} (${Date.now() - started}ms; ${results.at(-1).expected})`);
      if (options.verbose || !ok) process.stdout.write(output);
      if (!ok) throw new Error(`Unexpected or incomplete TLC result: ${test.name}`);
    }
    console.log(`Formal checks completed: ${results.length} cases; finite model results, not implementation proof.`);
    return results;
  } finally {
    if (options.report) writeFileSync(options.report, JSON.stringify({ toolchain: manifest.toolchain, results }, null, 2) + '\n');
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--list' && args.length === 1) console.log(JSON.stringify(manifest, null, 2));
    else {
      const ids = [];
      const options = {};
      for (let index = 0; index < args.length; index++) {
        if (args[index] === '--verbose') options.verbose = true;
        else if (args[index] === '--report') {
          if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--report needs a file path');
          options.report = args[++index];
        } else if (args[index].startsWith('-')) throw new Error(`Unknown option: ${args[index]}`);
        else ids.push(args[index]);
      }
      run(ids, options);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
