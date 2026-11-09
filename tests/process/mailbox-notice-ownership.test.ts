import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { putSteerMail, pullSteerMails, retractSteerMail } from '../../src/conversation/steer-mailbox';

it.each(['consumer-first', 'retraction-first'])('independent process ownership: %s', order => {
  const root = mkdtempSync(join(tmpdir(), 'aria-mail-notice-process-'));
  try {
    const scopedRequire = createRequire(createRequire(import.meta.url).resolve('tsup'));
    const bundle = join(root, 'mailbox.cjs');
    scopedRequire('esbuild').buildSync({ entryPoints: [resolve('src/conversation/steer-mailbox.ts')],
      bundle: true, platform: 'node', format: 'cjs', outfile: bundle });
    putSteerMail(root, 'scope', { requestId: 'one', body: 'execute once' });
    const child = (operation: 'pull' | 'retract') => {
      const result = spawnSync(process.execPath, ['-e', `
        const mail = require(process.argv[1]);
        const value = process.argv[3] === 'pull'
          ? mail.pullSteerMails(process.argv[2], 'scope').length
          : mail.retractSteerMail(process.argv[2], 'scope', 'one');
        process.stdout.write(JSON.stringify(value));
      `, bundle, root, operation], { encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    if (order === 'consumer-first') {
      expect(child('pull')).toBe(1);
      expect(retractSteerMail(root, 'scope', 'one')).toBe(false);
    } else {
      expect(child('retract')).toBe(true);
      expect(pullSteerMails(root, 'scope')).toEqual([]);
    }
    expect(pullSteerMails(root, 'scope')).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
