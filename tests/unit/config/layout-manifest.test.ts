import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_LAYOUT_SCHEMA_VERSION,
  readLayoutManifest,
  writeLayoutManifest,
} from '../../../src/config/layout-manifest';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aria-layout-manifest-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('layout manifest', () => {
  it('treats an absent manifest as legacy/unmigrated', async () => {
    const root = await tempRoot();
    await expect(readLayoutManifest(join(root, 'layout.json'))).resolves.toBeUndefined();
  });

  it('writes and reads the current schema atomically', async () => {
    const root = await tempRoot();
    const path = join(root, 'layout.json');
    await writeLayoutManifest(path, { schemaVersion: CURRENT_LAYOUT_SCHEMA_VERSION });
    await expect(readLayoutManifest(path)).resolves.toEqual({ schemaVersion: 1 });
    await expect(readFile(path, 'utf8')).resolves.toBe('{\n  "schemaVersion": 1\n}\n');
  });

  it('rejects invalid and newer schemas', async () => {
    const root = await tempRoot();
    const path = join(root, 'layout.json');
    await writeFile(path, '{"schemaVersion":0}\n');
    await expect(readLayoutManifest(path)).rejects.toThrow(/invalid Aria layout manifest/);
    await writeFile(path, '{"schemaVersion":999}\n');
    await expect(readLayoutManifest(path)).rejects.toThrow(/unsupported Aria layout schema/);
  });
});
