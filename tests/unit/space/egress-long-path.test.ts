import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareSpacePaths, resolveSpacePaths } from '../../../src/space/paths';
import { startSpaceEgress } from '../../../src/space/egress';

it.runIf(process.platform === 'linux')('container proxy reaches a long-path broker and preserves its endpoint policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-egress-long-'));
  const paths = resolveSpacePaths(join(root, 'nested-preparation-'.repeat(8)), { kind: 'default', profileId: 'test' });
  await prepareSpacePaths(paths);
  const broker = await startSpaceEgress({ paths, endpoints: [{ hostname: 'model.example.com', port: 443 }] });
  try {
    expect(Buffer.byteLength(broker.socket)).toBeGreaterThan(108);
    // Exercise the generated wrapper exactly as an execution backend invokes it:
    // unlike bubblewrap there is no short socket alias in the argument list.
    const code = `const net=require('node:net');const p=new URL(process.env.HTTPS_PROXY);const s=net.connect(Number(p.port),p.hostname,()=>s.write('CONNECT forbidden.example.com:443 HTTP/1.1\\r\\n\\r\\n'));let answer='';s.on('data',c=>answer+=c);s.on('end',()=>{console.log(answer);process.exit(answer.startsWith('HTTP/1.1 403')?0:3)});s.on('error',()=>process.exit(2));`;
    const child = spawn(process.execPath, [broker.proxyEntry, broker.socket, process.execPath, '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      expect(exit, stderr + stdout).toBe(0);
      expect(stdout).toContain('HTTP/1.1 403 Forbidden');
    } finally { clearTimeout(timer); child.kill('SIGKILL'); }
  } finally { await broker.close(); await rm(root, { recursive: true, force: true }); }
}, 10000);
