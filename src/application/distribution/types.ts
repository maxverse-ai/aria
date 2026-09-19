export const RELEASE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const INSTALL_STATE_SCHEMA_VERSION = 1 as const;
export const UPDATE_PLAN_SCHEMA_VERSION = 1 as const;
export const UPDATE_OPERATION_SCHEMA_VERSION = 1 as const;

export type DistributionChannel = 'internal';

export interface ReleaseDescriptor {
  channel: DistributionChannel;
  repository: string;
  tag: string;
  version: string;
  commit: string;
  publishedAt: string;
  immutable: true;
  assets: string[];
}

export interface ReleaseManifestV1 {
  schemaVersion: 1;
  channel: DistributionChannel;
  repository: string;
  tag: string;
  version: string;
  commit: string;
  packageName: string;
  artifactManifest: string;
  tarball: string;
  checksums: string;
  sha256: string;
  nodeRange: string;
  stateSchemaVersion: number;
  minRollbackVersion: string | null;
  createdAt: string;
}

export interface VerifiedRelease {
  descriptor: ReleaseDescriptor;
  manifest: ReleaseManifestV1;
  directory: string;
  tarballPath: string;
  artifactManifestPath: string;
  checksumsPath: string;
}

export interface InstalledVersion {
  version: string;
  tag: string;
  commit: string;
  sha256: string;
  installDir: string;
  entryPath: string;
  installedAt: string;
}

export interface InstallStateV1 {
  schemaVersion: 1;
  channel: DistributionChannel;
  repository: string;
  current: InstalledVersion | null;
  previous: InstalledVersion | null;
  versions: InstalledVersion[];
  updatedAt: string;
}

export interface UpdateServiceTarget {
  serviceId: string;
  kind: 'profile-service' | 'supervisor-service';
  profiles: string[];
  running: boolean;
}

export interface UpdatePlanV1 {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  expiresAt: string;
  channel: DistributionChannel;
  repository: string;
  expectedCurrentSha256: string | null;
  current: InstalledVersion | null;
  target: ReleaseDescriptor & { sha256: string };
  downloadDirectory: string;
  services: UpdateServiceTarget[];
  force: boolean;
  /**
   * Set by `aria update cancel`. The plan file is kept as evidence — the
   * timestamp marks it unusable for `apply` without deleting it.
   */
  cancelledAt?: string;
}

export type UpdateOperationStatus =
  | 'planned'
  | 'verifying'
  | 'installing'
  | 'switching'
  | 'restarting'
  | 'healthy'
  | 'rolling-back'
  | 'succeeded'
  | 'failed';

export interface UpdateOperationV1 {
  schemaVersion: 1;
  id: string;
  operation: 'update' | 'rollback';
  planId: string | null;
  status: UpdateOperationStatus;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  target:
    | { kind: 'release'; release: ReleaseDescriptor & { sha256: string } }
    | { kind: 'installed'; version: InstalledVersion };
  previous: InstalledVersion | null;
  installed: InstalledVersion | null;
  error: { code: string; message: string } | null;
}

export interface ReleaseSource {
  list(channel: DistributionChannel): Promise<ReleaseDescriptor[]>;
  download(release: ReleaseDescriptor, directory: string): Promise<void>;
}

export interface ReleaseVerifier {
  verify(release: ReleaseDescriptor, directory: string): Promise<VerifiedRelease>;
}

export interface VersionInstaller {
  install(release: VerifiedRelease): Promise<InstalledVersion>;
  smokeTest(version: InstalledVersion): Promise<void>;
}

export interface ServiceOrchestrator {
  discover(): Promise<UpdateServiceTarget[]>;
  assertSafe(targets: UpdateServiceTarget[], force: boolean): Promise<void>;
  reconcileLaunchers(
    targets: UpdateServiceTarget[],
    launcher: { runtimePath: string; entryPath: string },
  ): Promise<void>;
  restartAndCheck(targets: UpdateServiceTarget[], expectedVersion: string): Promise<void>;
}

export interface DetachedUpdateExecutor {
  execute(planId: string): Promise<{ operationId: string; detached: boolean }>;
  executeRollback(force: boolean): Promise<{ operationId: string; detached: boolean }>;
}

export interface DistributionRepository {
  readState(defaults?: { channel?: 'internal'; repository?: string }): Promise<InstallStateV1>;
  writeState(state: InstallStateV1): Promise<void>;
  newId(prefix: 'plan' | 'op'): string;
  downloadPath(id: string): string;
  writePlan(plan: UpdatePlanV1): Promise<void>;
  readPlan(id: string): Promise<UpdatePlanV1>;
  writeOperation(operation: UpdateOperationV1): Promise<void>;
  readOperation(id: string): Promise<UpdateOperationV1>;
  readLatestOperation(): Promise<UpdateOperationV1 | undefined>;
  listOperations(): Promise<UpdateOperationV1[]>;
  withLock<T>(fn: () => Promise<T>): Promise<T>;
}

export interface StableLauncherPort {
  launchSpec(): { runtimePath: string; entryPath: string };
  write(): Promise<void>;
}
