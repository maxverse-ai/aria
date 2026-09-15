import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareSpacePaths, resolveSpacePaths } from '../../src/space/paths';
import { startSpaceEgress, publicModelAddress } from '../../src/space/egress';
import { withConfinedLaunch, type ConfinedLaunch } from '../../src/space/launch';
import { spawnProcess } from '../../src/platform/spawn';
import { confinedClaudeHistory } from '../../src/space/claude-history';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aria-space-query-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const paths = resolveSpacePaths(root, { kind: 'default', profileId: 'test' }); await prepareSpacePaths(paths);
  const launch: ConfinedLaunch = { paths, binary: process.execPath, bubblewrap: '/usr/bin/bwrap',
    executableRoots: [dirname(dirname(process.execPath))], environment: {}, workspaceAccess: 'read-only' };
  return { root, paths, launch };
}
it.runIf(process.platform === 'linux')('D1/D3: Claude history helper cannot follow a symlink into another space or host home', async () => {
  const { root, paths, launch } = await fixture();
  const history = join(paths.home, '.claude', 'projects', paths.workspace.replace(/[^A-Za-z0-9]/g, '-')); await mkdir(history, { recursive: true });
  const row = (text: string) => JSON.stringify({ type: 'user', message: { content: text } }) + '\n';
  await writeFile(join(history, 'owned.jsonl'), row('owned prompt'));
  const secret = join(root, 'foreign.jsonl'); await writeFile(secret, row('foreign prompt'));
  await symlink(secret, join(history, 'escape.jsonl'));
  expect(confinedClaudeHistory(launch, process.execPath, paths.workspace, 10)).toEqual([
    expect.objectContaining({ id: 'owned', preview: 'owned prompt' }),
  ]);
  expect(() => confinedClaudeHistory(launch, process.execPath, root, 10)).toThrow('outside');
});
it.runIf(process.platform === 'linux')('D3: a confined native child reaches only its explicit CONNECT broker, which rejects unlisted hosts', async () => {
  const { paths, launch } = await fixture();
  const broker = await startSpaceEgress({ paths, endpoints: [{ hostname: 'model.example.com', port: 443 }] }); cleanups.push(() => broker.close());
  const code = `const net=require('node:net');const proxy=new URL(process.env.HTTPS_PROXY);const s=net.connect(Number(proxy.port),proxy.hostname,()=>s.write('CONNECT forbidden.example.com:443 HTTP/1.1\\r\\n\\r\\n'));let answer='';s.on('data',c=>answer+=c);s.on('end',()=>console.log(JSON.stringify({blocked:answer.startsWith('HTTP/1.1 403'),home:process.env.HOME})));s.on('error',()=>process.exit(2));`;
  const child = withConfinedLaunch({ ...launch, proxy: { node: process.execPath, entry: broker.proxyEntry, socket: broker.socket } },
    () => spawnProcess(process.execPath, ['-e', code], { cwd: paths.workspace, stdio: ['ignore', 'pipe', 'pipe'] }));
  let stdout = ''; let stderr = ''; child.stdout!.on('data', c => stdout += c); child.stderr!.on('data', c => stderr += c);
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const codeResult = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); clearTimeout(timer);
  expect(codeResult, stderr).toBe(0); expect(JSON.parse(stdout)).toEqual({ blocked: true, home: paths.home });
  await broker.close();
});
it('rejects DNS targets in private, reserved, documentation and IPv6 ranges', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', '224.0.0.1']) expect(publicModelAddress(address)).toBe(false);
  expect(publicModelAddress('8.8.8.8')).toBe(true);
});
