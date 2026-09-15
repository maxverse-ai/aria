import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveSpacePaths, prepareSpacePaths } from '../../src/space/paths';
import { withConfinedLaunch, type ConfinedLaunch } from '../../src/space/launch';
import { spawnProcessSync } from '../../src/platform/spawn';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

describe('Linux execution space process boundary', () => {
  it.runIf(process.platform === 'linux')('D3: denies sibling/control/home files, ambient credentials, host network and child escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-space-process-')); roots.push(root);
    const paths = resolveSpacePaths(root, { kind: 'default', profileId: 'test' });
    await prepareSpacePaths(paths);
    const secret = join(root, 'host-secret'); await writeFile(secret, 'operator');
    await writeFile(join(paths.control, 'private.json'), 'control');
    const hostServer = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => hostServer.listen(0, '127.0.0.1', resolve));
    const hostPort = (hostServer.address() as AddressInfo).port;
    const launch: ConfinedLaunch = { paths, binary: process.execPath, bubblewrap: '/usr/bin/bwrap',
      executableRoots: [dirname(dirname(process.execPath))], environment: {}, workspaceAccess: 'read-only' };
    const code = `
      const fs = require('node:fs');
      const cp = require('node:child_process');
      const results = {};
      for (const [label, file] of [['host', ${JSON.stringify(secret)}], ['control', ${JSON.stringify(join(paths.control, 'private.json'))}]]) {
        try { fs.readFileSync(file); results[label] = 'exposed'; } catch { results[label] = 'denied'; }
      }
      results.ambient = process.env.SPACE_TEST_AMBIENT_SECRET ?? 'absent';
      try { fs.writeFileSync('should-not-write', 'x'); results.write = 'allowed'; } catch { results.write = 'denied'; }
      const child = cp.spawnSync(process.execPath, ['-e', 'try { require("node:fs").readFileSync(process.argv[1]); process.exit(5); } catch { process.exit(0); }', ${JSON.stringify(secret)}]);
      results.child = child.status;
      const socket = require('node:net').connect(${hostPort}, '127.0.0.1');
      socket.on('error', () => { results.network = 'denied'; console.log(JSON.stringify(results)); });
      socket.on('connect', () => { results.network = 'exposed'; socket.destroy(); console.log(JSON.stringify(results)); });
    `;
    const result = withConfinedLaunch(launch, () => spawnProcessSync(process.execPath, ['-e', code], {
      cwd: paths.workspace, encoding: 'utf8', env: { ...process.env, SPACE_TEST_AMBIENT_SECRET: 'must-not-leak' }, timeout: 10000,
    }));
    await new Promise<void>((resolve) => hostServer.close(() => resolve()));
    // A deployment without the required isolation driver fails this gate rather than
    // silently running the security test on the host or labelling it supported.
    expect(result.status, String(result.stderr)).toBe(0);
    expect(JSON.parse(String(result.stdout))).toEqual({ host: 'denied', control: 'denied', ambient: 'absent', write: 'denied', child: 0, network: 'denied' });
  });
});
