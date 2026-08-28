import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const MANAGED_WORKSPACE_AGENTS = `# Aria Managed Workspace

This is an identity-neutral landing workspace, not a project repository.

- Identify the target project before making changes.
- Read the target project's applicable \`AGENTS.md\` files.
- Run project commands from the target project or its authorized task workspace.
- Keep disposable, non-secret material under \`scratch/\`.
- Do not store credentials or account secrets in this workspace.
- If the target or authorization is ambiguous, perform read-only discovery and ask.
`;

export const MANAGED_WORKSPACE_README = `# Aria Managed Workspace

This directory is the default working area created by Aria for this profile.
It is intentionally identity-neutral and is not initialized as a Git repository.

Use \`scratch/\` for disposable, non-secret material. Switch to a real project
with \`/cd <path>\` or save and select a named workspace with \`/ws\`.
`;

export interface ManagedWorkspaceInitializationResult {
  root: string;
  created: boolean;
  scaffolded: boolean;
}

/**
 * Create an Aria-owned default workspace without overwriting existing content.
 * Existing custom or non-empty directories are accepted but never scaffolded.
 */
export async function initializeManagedWorkspace(
  root: string,
): Promise<ManagedWorkspaceInitializationResult> {
  const parent = dirname(root);
  if (parent === root) throw new Error(`managed workspace path is too broad: ${root}`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent);
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error(`managed workspace parent is not a safe directory: ${parent}`);
  }
  let created = false;
  try {
    await mkdir(root, { mode: 0o700 });
    created = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }

  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error(`managed workspace path is not a safe directory: ${root}`);
  }

  const scaffolded = created || (await isSafeScaffoldContinuation(root));
  if (scaffolded) await writeMissingScaffold(root);
  return { root: await realpath(root), created, scaffolded };
}

async function isSafeScaffoldContinuation(root: string): Promise<boolean> {
  const entries = await readdir(root);
  if (entries.length === 0) return true;
  const allowed = new Set(['AGENTS.md', 'README.md', 'scratch']);
  if (entries.some((entry) => !allowed.has(entry))) return false;

  if (entries.includes('AGENTS.md')) {
    if (!(await isExactRegularFile(join(root, 'AGENTS.md'), MANAGED_WORKSPACE_AGENTS))) return false;
  }
  if (entries.includes('README.md')) {
    if (!(await isExactRegularFile(join(root, 'README.md'), MANAGED_WORKSPACE_README))) return false;
  }
  if (entries.includes('scratch')) {
    const scratch = await lstat(join(root, 'scratch'));
    if (scratch.isSymbolicLink() || !scratch.isDirectory()) return false;
  }
  return true;
}

async function isExactRegularFile(path: string, expected: string): Promise<boolean> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(`managed workspace scaffold path is an unsafe symbolic link: ${path}`);
  }
  if (!info.isFile()) return false;
  return (await readFile(path, 'utf8')) === expected;
}

async function writeMissingScaffold(root: string): Promise<void> {
  await writeExclusive(join(root, 'AGENTS.md'), MANAGED_WORKSPACE_AGENTS);
  await writeExclusive(join(root, 'README.md'), MANAGED_WORKSPACE_README);
  try {
    await mkdir(join(root, 'scratch'), { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const info = await lstat(join(root, 'scratch'));
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`managed workspace scratch path is not a safe directory: ${join(root, 'scratch')}`);
    }
  }
}

async function writeExclusive(path: string, content: string): Promise<void> {
  try {
    await writeFile(path, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (!(await isExactRegularFile(path, content))) {
      throw new Error(`managed workspace scaffold conflict: ${path}`);
    }
  }
}
