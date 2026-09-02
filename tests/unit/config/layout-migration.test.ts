import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { resolveAriaLayoutPaths } from '../../../src/config/layout-paths';
import { planProfileLayoutMigration } from '../../../src/config/layout-migration';

describe('layout migration plan', () => {
  it('separates persistent, disposable, and runtime paths without moving workspaces', () => {
    const roots = { stateRoot: '/state/aria', workspaceRoot: '/work/aria' };
    const legacy = resolveAppPaths({
      rootDir: roots.stateRoot,
      workspaceRoot: roots.workspaceRoot,
      profile: 'codex-dev',
    });
    const target = resolveAriaLayoutPaths(roots, 'codex-dev');

    const plan = planProfileLayoutMigration(legacy, target);

    expect(plan.schemaVersion).toBe(1);
    expect(plan.operations).toContainEqual({
      source: join(roots.stateRoot, 'profiles', 'codex-dev', 'secrets.enc'),
      destination: join(roots.stateRoot, 'profiles', 'codex-dev', 'identity', 'secrets.enc'),
      lifecycle: 'persistent',
      action: 'move',
    });
    expect(plan.operations.filter((operation) => operation.action === 'recreate')).toHaveLength(3);
    expect(plan.operations.some((operation) => operation.source.startsWith(roots.workspaceRoot))).toBe(false);
  });
});
