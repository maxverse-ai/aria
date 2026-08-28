import { join } from 'node:path';
import type { AppPaths } from './app-paths';
import type { AriaLayoutPaths } from './layout-paths';

export type LayoutMigrationLifecycle =
  | 'persistent'
  | 'cache'
  | 'logs'
  | 'runtime';

export interface LayoutMigrationOperation {
  source: string;
  destination?: string;
  lifecycle: LayoutMigrationLifecycle;
  action: 'move' | 'recreate';
}

export interface LayoutMigrationPlan {
  schemaVersion: 1;
  profile: string;
  operations: LayoutMigrationOperation[];
}

/**
 * Build a deterministic, mutation-free plan from the compatibility layout to
 * the typed target layout. Execution, locking, verification, and rollback are
 * intentionally separate concerns.
 */
export function planProfileLayoutMigration(
  legacy: AppPaths,
  target: AriaLayoutPaths,
): LayoutMigrationPlan {
  return {
    schemaVersion: 1,
    profile: legacy.profile,
    operations: [
      move(legacy.secretsFile, target.profile.identity.secretsFile, 'persistent'),
      move(legacy.keystoreSaltFile, target.profile.identity.keystoreSaltFile, 'persistent'),
      move(legacy.larkCliSourceDir, target.profile.identity.larkCliSourceDir, 'persistent'),
      move(legacy.larkCliConfigDir, target.profile.identity.larkCliDir, 'persistent'),
      move(legacy.sessionsFile, target.profile.state.sessionsFile, 'persistent'),
      move(`${legacy.sessionsFile}.catalog.json`, target.profile.state.sessionCatalogFile, 'persistent'),
      move(legacy.workspacesFile, target.profile.state.workspacesFile, 'persistent'),
      move(legacy.nativeReadDir, target.profile.state.nativeReadDir, 'persistent'),
      move(legacy.mediaDir, join(target.profile.cacheDir, 'media'), 'cache'),
      move(legacy.logsDir, target.profile.logsDir, 'logs'),
      recreate(legacy.runtimeControlFile),
      recreate(legacy.runtimeControlEndpoint),
      recreate(legacy.uiFile),
    ],
  };
}

function move(
  source: string,
  destination: string,
  lifecycle: Exclude<LayoutMigrationLifecycle, 'runtime'>,
): LayoutMigrationOperation {
  return { source, destination, lifecycle, action: 'move' };
}

function recreate(source: string): LayoutMigrationOperation {
  return { source, lifecycle: 'runtime', action: 'recreate' };
}
