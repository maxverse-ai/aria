import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { detectInvokingInstallation } from '../../../src/composition/distribution';

it('uses the real legacy executable version for the rollback baseline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-legacy-'));
  try {
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@maxverse-ai/aria', version: '0.4.7' }));
    const entry = join(root, 'bin', 'aria.mjs');
    await writeFile(entry, "console.log('0.4.5');");
    expect(await detectInvokingInstallation(entry)).toMatchObject({ version: '0.4.5', tag: 'legacy-v0.4.5', entryPath: entry });
    await writeFile(entry, "console.log('unexpected output');");
    await expect(detectInvokingInstallation(entry)).rejects.toThrow('invalid stable version');
    await expect(detectInvokingInstallation(entry, { run: async () => {
      await writeFile(entry, 'changed'); return { stdout: '0.4.5', stderr: '' };
    } })).rejects.toThrow('changed while probing');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('adopts a Windows/npm command shim through its actual JS package entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aria-shim-'));
  const previousPath = process.env.PATH;
  try {
    const packageRoot = join(root, 'node_modules', '@maxverse-ai', 'aria');
    await mkdir(join(packageRoot, 'bin'), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@maxverse-ai/aria', version: '0.4.7' }));
    const entry = join(packageRoot, 'bin', 'aria.mjs');
    await writeFile(entry, "console.log('0.4.5');");
    await writeFile(join(root, 'aria'), '#!/bin/sh\nnot JavaScript');
    process.env.PATH = root;
    expect(await detectInvokingInstallation(join(root, 'standalone-installer.mjs'))).toMatchObject({
      version: '0.4.5', entryPath: entry, installDir: packageRoot,
    });
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
