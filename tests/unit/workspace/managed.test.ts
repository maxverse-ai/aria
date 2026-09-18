import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  initializeManagedWorkspace,
  MANAGED_WORKSPACE_AGENTS,
  MANAGED_WORKSPACE_README,
} from '../../../src/workspace/managed';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aria-managed-workspace-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('initializeManagedWorkspace', () => {
  it('creates the exact identity-neutral scaffold', async () => {
    const parent = await tempRoot();
    const workspace = join(parent, 'profile', 'default');

    await expect(initializeManagedWorkspace(workspace)).resolves.toMatchObject({
      created: true,
      scaffolded: true,
    });

    expect((await readdir(workspace)).sort()).toEqual(['AGENTS.md', 'README.md', 'scratch']);
    expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toBe(MANAGED_WORKSPACE_AGENTS);
    expect(await readFile(join(workspace, 'README.md'), 'utf8')).toBe(MANAGED_WORKSPACE_README);
    if (process.platform !== 'win32') {
      expect((await lstat(workspace)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(workspace, 'AGENTS.md'))).mode & 0o777).toBe(0o600);
      expect((await lstat(join(workspace, 'README.md'))).mode & 0o777).toBe(0o600);
      expect((await lstat(join(workspace, 'scratch'))).mode & 0o777).toBe(0o700);
    }
    const templates = `${MANAGED_WORKSPACE_AGENTS}\n${MANAGED_WORKSPACE_README}`;
    expect(templates).not.toMatch(/\/home\/|\\Users\\|app[_ -]?id|tenant[_ -]?id|@users\.noreply/iu);
  });

  it('is idempotent and completes a matching partial scaffold', async () => {
    const parent = await tempRoot();
    const workspace = join(parent, 'default');
    await mkdir(workspace);
    await writeFile(join(workspace, 'AGENTS.md'), MANAGED_WORKSPACE_AGENTS, { mode: 0o600 });

    await expect(initializeManagedWorkspace(workspace)).resolves.toMatchObject({
      created: false,
      scaffolded: true,
    });
    await expect(initializeManagedWorkspace(workspace)).resolves.toMatchObject({
      created: false,
      scaffolded: true,
    });
    expect((await readdir(workspace)).sort()).toEqual(['AGENTS.md', 'README.md', 'scratch']);
  });

  it('does not modify a pre-existing user directory', async () => {
    const parent = await tempRoot();
    const workspace = join(parent, 'default');
    await mkdir(workspace);
    await writeFile(join(workspace, 'user.txt'), 'owned by user', 'utf8');

    await expect(initializeManagedWorkspace(workspace)).resolves.toMatchObject({
      created: false,
      scaffolded: false,
    });
    expect(await readdir(workspace)).toEqual(['user.txt']);
  });

  it('rejects a symbolic-link workspace root', async () => {
    const parent = await tempRoot();
    const target = join(parent, 'target');
    const workspace = join(parent, 'default');
    await mkdir(target);
    await symlink(target, workspace, 'dir');

    await expect(initializeManagedWorkspace(workspace)).rejects.toThrow(/not a safe directory/);
  });

  it('fails closed on a scaffold-file symbolic link', async () => {
    const parent = await tempRoot();
    const workspace = join(parent, 'default');
    const target = join(parent, 'instructions');
    await mkdir(workspace);
    await writeFile(target, MANAGED_WORKSPACE_AGENTS, 'utf8');
    await symlink(target, join(workspace, 'AGENTS.md'));

    await expect(initializeManagedWorkspace(workspace)).rejects.toThrow(/unsafe symbolic link/);
  });

  it('rejects a symbolic-link workspace parent', async () => {
    const parent = await tempRoot();
    const target = join(parent, 'target-profile');
    const linkedProfile = join(parent, 'linked-profile');
    await mkdir(target);
    await symlink(target, linkedProfile, 'dir');

    await expect(initializeManagedWorkspace(join(linkedProfile, 'default'))).rejects.toThrow(
      /parent is not a safe directory/,
    );
  });
});
