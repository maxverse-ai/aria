import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareSpacePaths, resolveSpacePaths } from '../../../src/space/paths';
import { startSpaceEgress } from '../../../src/space/egress';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aria-egress-stdio-'));
  const paths = resolveSpacePaths(root, { kind: 'default', profileId: 'test' });
  await prepareSpacePaths(paths);
  const broker = await startSpaceEgress({ paths, endpoints: [] });
  return { broker, async close() { await broker.close(); await rm(root, { recursive: true, force: true }); } };
}

it('drains large stdout and stderr through a slow receiver after native exit', async () => {
  const f = await fixture();
  const bytes = 4 * 1024 * 1024;
  // The producer confirms its writes before exit; the wrapper must still drain
  // its independent output buffers before mirroring that exit status.
  const code = `const b=Buffer.alloc(${bytes},120);process.stdout.write(b,()=>process.stderr.write(b,()=>process.exit(7)))`;
  const child = spawn(process.execPath, [f.broker.proxyEntry, f.broker.socket, process.execPath, '-e', code], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  let out = Buffer.alloc(0); let err = Buffer.alloc(0);
  const closed = new Promise(resolve => child.once('close', resolve));
  const resume = setTimeout(() => {
    child.stdout.on('data', b => { out = Buffer.concat([out, b]); });
    child.stderr.on('data', b => { err = Buffer.concat([err, b]); });
  }, 200);
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 12000);
  try {
    const status = await closed;
    expect(status, err.toString().replace(/x{10,}/g, '[data]')).toBe(7);
    expect(out.equals(Buffer.alloc(bytes, 120))).toBe(true);
    expect(err.equals(Buffer.alloc(bytes, 120)), JSON.stringify({length:err.length, extra:err.toString().replace(/x{10,}/g,'[data]')})).toBe(true);
  } finally { clearTimeout(resume); clearTimeout(watchdog); child.kill('SIGKILL'); await f.close(); }
}, 15000);

it('terminates the producer when the receiver disconnects', async () => {
  const f = await fixture();
  const code = `const b=Buffer.alloc(65536);function write(){while(process.stdout.write(b)){}process.stdout.once('drain',write)}write()`;
  const child = spawn(process.execPath, [f.broker.proxyEntry, f.broker.socket, process.execPath, '-e', code], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_NO_WARNINGS: '1' } });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stderr.resume();
  child.stdout.once('data', () => child.stdout.destroy());
  const watchdog = setTimeout(() => child.kill('SIGKILL'), 12000);
  try { expect(await closed).toBe(1); }
  finally { clearTimeout(watchdog); child.kill('SIGKILL'); await f.close(); }
}, 15000);
