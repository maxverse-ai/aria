import { request } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import type { SessionCatalogEntry } from '../../../src/session/catalog';
import { DefaultNativeReadProfileRuntime } from '../../../src/runtime/native-read-runtime';

const roots: string[] = [];
const runtimes: DefaultNativeReadProfileRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.stop()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DefaultNativeReadProfileRuntime', () => {
  it('starts only when called, projects sessions and removes the socket on stop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-native-runtime-'));
    roots.push(root);
    const paths = resolveAppPaths({ rootDir: root, profile: 'demo' });
    const entries: SessionCatalogEntry[] = [catalogEntry('thread-secret-1', 1)];
    const runtime = new DefaultNativeReadProfileRuntime({
      profileId: 'demo', appPaths: paths, sessionCatalog: { entries: () => entries },
      token: 'secret', scopes: ['read:sessions'], serverVersion: 'test', instanceId: 'instance-1',
    });
    runtimes.push(runtime);

    if (process.platform !== 'win32') {
      await expect(stat(paths.nativeReadEndpoint)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await Promise.all([runtime.start(), runtime.start()]);

    const response = await get(paths.nativeReadEndpoint, '/v1/sessions', 'secret');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      items: [expect.objectContaining({ agentKind: 'codex', status: 'active' })],
    });
    expect(JSON.stringify(response.body)).not.toContain('thread-secret-1');
    expect(await readFile(paths.nativeReadJournalFile, 'utf8')).not.toContain('thread-secret-1');

    await runtime.stop();
    if (process.platform !== 'win32') {
      await expect(stat(paths.nativeReadEndpoint)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('refreshes newly observed catalog entries without restarting the API', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aria-native-runtime-'));
    roots.push(root);
    const paths = resolveAppPaths({ rootDir: root, profile: 'demo' });
    const entries: SessionCatalogEntry[] = [catalogEntry('thread-secret-1', 1)];
    const runtime = new DefaultNativeReadProfileRuntime({
      profileId: 'demo', appPaths: paths, sessionCatalog: { entries: () => entries },
      token: 'secret', scopes: ['read:sessions'], serverVersion: 'test',
    });
    runtimes.push(runtime);
    await runtime.start();

    entries.push(catalogEntry('thread-secret-2', 2));
    await runtime.refreshSessions();

    const response = await get(paths.nativeReadEndpoint, '/v1/sessions', 'secret');
    expect((response.body as { items: unknown[] }).items).toHaveLength(2);
  });
});

function catalogEntry(threadId: string, suffix: number): SessionCatalogEntry {
  return {
    key: `scope-${suffix}\u001fcodex\u001f/repo\u001fpolicy`, scopeId: `scope-${suffix}`,
    agentId: 'codex', cwdRealpath: '/repo', policyFingerprint: 'policy', status: 'active',
    updatedAt: Date.UTC(2026, 7, 27, 0, 0, suffix), threadId,
  };
}

function get(socketPath: string, path: string, token: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, headers: { authorization: `Bearer ${token}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    req.once('error', reject);
    req.end();
  });
}
