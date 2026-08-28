import { join, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAriaLayoutPaths, resolveAriaRoots } from '../../../src/config/layout-paths';

describe('Aria layout paths', () => {
  it('resolves state and workspace roots independently', () => {
    const roots = resolveAriaRoots({
      env: {},
      homeDir: '/home/operator',
      stateRoot: '/state/aria',
      workspaceRoot: '/work/aria',
    });

    expect(roots).toEqual({ stateRoot: '/state/aria', workspaceRoot: '/work/aria' });
  });

  it('does not derive a custom workspace root from a custom state root', () => {
    const roots = resolveAriaRoots({
      env: {},
      homeDir: '/home/operator',
      stateRoot: '/state/custom',
    });

    expect(roots.workspaceRoot).toBe(join('/home/operator', '.aria-workspaces'));
  });

  it('computes typed target paths without creating anything', () => {
    const paths = resolveAriaLayoutPaths(
      { stateRoot: '/state/aria', workspaceRoot: '/work/aria' },
      'codex-dev',
    );

    expect(paths.root.layoutFile).toBe(join('/state/aria', 'layout.json'));
    expect(paths.profile.identity.secretsFile).toBe(
      join('/state/aria', 'profiles', 'codex-dev', 'identity', 'secrets.enc'),
    );
    expect(paths.profile.state.sessionsFile).toBe(
      join('/state/aria', 'profiles', 'codex-dev', 'state', 'sessions.json'),
    );
    expect(paths.profile.enginesDir).toBe(
      join('/state/aria', 'profiles', 'codex-dev', 'engines'),
    );
    expect(paths.workspace.instructionsFile).toBe(
      join('/work/aria', 'codex-dev', 'default', 'AGENTS.md'),
    );
  });

  it('supports Windows path forms through the pure path contract', () => {
    const roots = resolveAriaRoots({
      env: {},
      homeDir: 'C:\\Users\\operator',
      pathApi: win32,
    });
    const paths = resolveAriaLayoutPaths(roots, 'codex-dev', win32);

    expect(roots).toEqual({
      stateRoot: 'C:\\Users\\operator\\.aria',
      workspaceRoot: 'C:\\Users\\operator\\.aria-workspaces',
    });
    expect(paths.profile.runDir).toBe(
      'C:\\Users\\operator\\.aria\\profiles\\codex-dev\\run',
    );
    expect(paths.workspace.scratchDir).toBe(
      'C:\\Users\\operator\\.aria-workspaces\\codex-dev\\default\\scratch',
    );
  });
});
