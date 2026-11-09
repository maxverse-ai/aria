import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.TLA2TOOLS_JAR) throw new Error('Set TLA2TOOLS_JAR to TLC 1.7.4 and optionally JAVA.');
const source = fileURLToPath(new URL('.', import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), 'aria-architecture-tlc-'));
const cases = [
  ['PoolHandoff', 'TransferPermit', 'Capacity'],
  ['MailboxHandoff', 'Transactional', 'NoLostMail'],
  ['EngineSubscription', 'PerConnection', 'WatchMatchesConnection'],
  ['CallbackAck', 'Background', 'AckBeforeIO'],
  ['MailboxConsumers', 'AtomicClaim', 'SingleConsumer'],
];
try {
  for (const [name, flag, invariant] of cases) {
    writeFileSync(join(temporary, `${name}.tla`), readFileSync(join(source, `${name}.tla`)));
    for (const fixed of [false, true]) {
      const config = `${name}-${fixed ? 'reference' : 'current'}`;
      const constants = name === 'MailboxConsumers' ? 'CONSTANT Consumers = {pull, sweep}\n' : '';
      writeFileSync(join(temporary, `${config}.cfg`), `${constants}CONSTANT ${flag} = ${fixed ? 'TRUE' : 'FALSE'}\nINIT Init\nNEXT Next\nINVARIANT ${invariant}\nCHECK_DEADLOCK FALSE\n`);
      check(name, config, fixed ? null : invariant);
    }
  }
  const name = 'RuntimeRetirement';
  writeFileSync(join(temporary, `${name}.tla`), readFileSync(join(source, `${name}.tla`)));
  writeFileSync(join(temporary, `${name}.cfg`), 'CONSTANT Borrowers = {a, b}\nSPECIFICATION Spec\nINVARIANTS SafeRetirement NoDoubleRelease\nPROPERTY Drains\nCHECK_DEADLOCK FALSE\n');
  check(name, name, null);
} finally { rmSync(temporary, { recursive: true, force: true }); }

function check(name, config, violation) {
  const result = spawnSync(process.env.JAVA ?? 'java', ['-Xmx512m', '-XX:+UseParallelGC', '-cp', resolve(process.env.TLA2TOOLS_JAR),
    'tlc2.TLC', '-workers', '1', '-metadir', join(temporary, `${config}-states`), '-config', `${config}.cfg`, `${name}.tla`],
  { cwd: temporary, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  process.stdout.write(`\n=== ${config} ===\n${output}`);
  if (result.error || (violation
    ? result.status === 0 || !output.includes(`Invariant ${violation} is violated.`)
    : result.status !== 0 || !output.includes('Model checking completed. No error has been found.'))) {
    throw new Error(`Unexpected TLC result: ${config}`, { cause: result.error });
  }
}
