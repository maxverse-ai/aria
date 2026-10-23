import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveWindowsAgentBinary } from '../../../src/worker/native-agent-path';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'aria-npm-codex-'));
  roots.push(root);
  const packageRoot = join(root, 'node_modules', '@openai', 'codex');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
  return { root, packageRoot, shim: join(root, 'codex.cmd') };
}
async function executable(path: string) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, 'fixture', { mode: 0o755 });
}

describe('Windows native agent discovery', () => {
  it('resolves current npm optional platform package without launching the shim', async () => {
    const { root, shim } = await fixture();
    const platform = join(root, 'node_modules', '@openai', 'codex-win32-x64');
    await mkdir(platform, { recursive: true });
    await writeFile(join(platform, 'package.json'), JSON.stringify({ name: '@openai/codex-win32-x64' }));
    const binary = join(platform, 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
    await executable(binary);
    expect(await resolveWindowsAgentBinary('codex', shim, 'x64')).toBe(binary);
  });

  it('supports the older in-package vendor payload', async () => {
    const { packageRoot, shim } = await fixture();
    const binary = join(packageRoot, 'vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe');
    await executable(binary);
    expect(await resolveWindowsAgentBinary('codex', shim, 'arm64')).toBe(binary);
  });

  it('rejects an incomplete npm installation and unsupported wrapper engines', async () => {
    const { shim } = await fixture();
    expect(await resolveWindowsAgentBinary('codex', shim, 'x64')).toBeUndefined();
    expect(await resolveWindowsAgentBinary('codex', shim, 'ia32')).toBeUndefined();
    expect(await resolveWindowsAgentBinary('claude', shim, 'x64')).toBeUndefined();
    expect(await resolveWindowsAgentBinary('dsh', shim, 'x64')).toBeUndefined();
  });

  it('accepts existing native executables but never a directory named exe', async () => {
    const { root } = await fixture();
    const binary = join(root, 'claude.exe');
    await executable(binary);
    expect(await resolveWindowsAgentBinary('claude', binary)).toBe(binary);
    const directory = join(root, 'directory.exe');
    await mkdir(directory);
    expect(await resolveWindowsAgentBinary('dsh', directory)).toBeUndefined();
  });
});
