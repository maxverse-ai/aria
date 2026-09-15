import { retainPreparation, retainedPreparations } from './retained-preparation';
import { SpaceReadAccess } from './read-access';
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { resolveAppPaths, type AppPaths } from '../config/app-paths';
import type { ProfileConfig, RootConfig } from '../config/profile-schema';
import type { ExecutionSpaceSelection } from '../config/execution-spaces';
import { FileConfigRepository, type ConfigRepository } from '../application/control/config-repository';
import { ConfigChangeService } from '../application/control/config-change-service';
import { configRevision } from '../application/control/config-revision';
import { ControlChangeError, type ControlActorContext } from '../application/control/change-types';
import { ManagementApi, MANAGEMENT_API_VERSION } from '../application/control/management-api';
import { ManagementCommandRegistry } from '../application/control/management-command-registry';
import { profileModeTransitionCommand } from '../application/control/profile-mode-command';
import { acquireProfileRuntimeLock, checkRuntimeLock } from '../runtime/locks';
import { writeFileAtomic } from '../platform/atomic-write';
import { inspectLegacySpaceState, type LegacySpaceInventory } from './legacy-inventory';
import { normalizeSpaceDeployment, probeSpaceDeployment, readPrivateJson, type SpaceDeploymentDefinition } from './deployment';
import { executionFingerprint, preparationPaths, preparationStoragePaths, readPreparation, writePreparation, type SpacePreparationReceipt } from './preparation-store';
import { assertConfinedPath, prepareSpacePaths, resolveSpacePaths } from './paths';
import { stagedStateDigest } from './staged-state';
import { join } from 'node:path';
import { digestFile } from '../platform/file-digest';
import { executionSpaceMode, spaceEngineCapabilities } from './capabilities';

/** A host-installed migration adapter. It must prove native resume and ownership
 * before returning any imported key. This is not a decoded worker request. */
export interface SpaceMigrationAdapter {
  prepare(input: { profile: ProfileConfig; profileId: string; directory: string; inventory: LegacySpaceInventory;
    deployment: SpaceDeploymentDefinition }): Promise<{ importedKeys: readonly string[];
      sourceChecks?: readonly { path: string; sha256: string }[]; verify(): Promise<void> }>;
}
export interface SpaceManagementOptions {
  rootDir?: string;
  repository?: ConfigRepository;
  /** The composition authenticates operators; checking caller-supplied source
   * strings inside the domain is not authentication. */
  authorize: (actor: ControlActorContext, profile: string) => boolean;
  migration?: SpaceMigrationAdapter;
}

/** Single management owner: immutable staging, existing runtime lock and config
 * mutation kernel. Neither a CLI nor a container launcher writes mode directly. */
export class SpaceManagementService {
  private readonly rootDir: string;
  private readonly repository: ConfigRepository;
  constructor(private readonly options: SpaceManagementOptions) {
    this.rootDir = resolveAppPaths({ rootDir: options.rootDir }).rootDir;
    this.repository = options.repository ?? new FileConfigRepository(this.rootDir);
  }

  async status(profile: string, actor: ControlActorContext) {
    const { config, paths, root } = await this.target(profile, actor);
    const inventory = await inspectLegacySpaceState(paths);
    const lock = await checkRuntimeLock(paths.profileLockFile);
    const receipt = config.executionSpaces ? await readPreparation(paths.profileDir, config.executionSpaces) : undefined;
    return { schema: 'aria.space.status.v1', profile: paths.profile, revision: configRevision(root),
      mode: config.mode, execution: receipt ? 'prepared-spaces' : 'legacy',
      executionMode: executionSpaceMode(config),
      retained: (await retainedPreparations(paths.profileDir, paths.profile)).map(value => ({
        selection: value.selection, rolledBackAt: value.rolledBackAt,
        legacyChanged: value.legacyDigest !== inventory.digest,
      })),
      running: lock.locked, legacy: { sessions: inventory.sessions.length, digest: inventory.digest, pendingWork: inventory.pendingWork },
      ...(receipt ? { selection: config.executionSpaces, driver: receipt.deployment.driver,
        capabilities: spaceEngineCapabilities(receipt.deployment.engineId, receipt.deployment),
        importedSessions: receipt.migration.importedSessions, sealedSessions: receipt.migration.sealedSessions,
        configurationCurrent: receipt.executionFingerprint === executionFingerprint(config) } : {}) };
  }

  async prepare(profile: string, deployment: SpaceDeploymentDefinition, actor: ControlActorContext,
    preparationId = randomBytes(16).toString('hex')): Promise<ExecutionSpaceSelection> {
    return this.offline(profile, actor, async ({ config, paths, root }) => {
      if (config.executionSpaces) throw new Error('rollback the active preparation before preparing another migration');
      if (config.meeting.enabled) throw new Error('team meetings require a verified resource audience adapter before preparation');
      const definition = normalizeSpaceDeployment(deployment);
      if (definition.engineId !== config.agentKind) throw new Error('deployment engine differs from profile');
      if (definition.workspaceAccess !== config.permissions.defaultAccess) throw new Error('deployment access must match the effective native runtime ceiling');
      const inventory = await inspectLegacySpaceState(paths);
      if (inventory.pendingWork) throw new Error('legacy triggers must be drained or paused before space preparation');
      const staging = preparationPaths(paths.profileDir, preparationId);
      await assertConfinedPath(paths.profileDir, staging.receipt);
      const fingerprint = executionFingerprint(config);
      const baseRevision = configRevision(root);
      const intent = { schema: 'aria.space.migration.v1', preparationId, baseRevision, fingerprint,
        inventoryDigest: inventory.digest, deployment: definition };
      await mkdir(staging.directory, { recursive: true, mode: 0o700 });
      // A stable preparation id is resumable only for the exact same inputs.
      try {
        if (JSON.stringify(await readPrivateJson(staging.journal)) !== JSON.stringify(intent)) throw new Error('migration inputs changed; use a new preparation id');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await writeFileAtomic(staging.journal, JSON.stringify(intent) + '\n', { mode: 0o600 });
      }
      try {
        const receipt = await readPrivateJson(staging.receipt) as SpacePreparationReceipt;
        if (receipt.profileId !== paths.profile || receipt.baseRevision !== baseRevision
          || receipt.executionFingerprint !== fingerprint || receipt.migration?.catalogDigest !== inventory.digest
          || JSON.stringify(receipt.deployment) !== JSON.stringify(definition)
          || receipt.migration.stateDigest !== await stagedStateDigest(staging.state)) throw new Error('completed preparation changed');
        const selection = await writePreparation(paths.profileDir, receipt);
        await readPreparation(paths.profileDir, selection);
        await verifySources(receipt.migration.sourceChecks);
        return selection;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // This exact unsealed intent has never been activated. Rebuild only its
      // disposable destination on retry; neither legacy nor sealed state moves.
      await assertConfinedPath(paths.profileDir, staging.state);
      await rm(staging.state, { recursive: true, force: true });
      const probePaths = resolveSpacePaths(join(staging.directory, 'probe'), { kind: 'default', profileId: paths.profile });
      await prepareSpacePaths(probePaths);
      await probeSpaceDeployment(definition, probePaths);
      const imported = this.options.migration ? await this.options.migration.prepare({
        profile: config, profileId: paths.profile, directory: staging.state, inventory, deployment: definition,
      }) : { importedKeys: [] as readonly string[], sourceChecks: [], verify: async () => {} };
      const keys = new Set(imported.importedKeys);
      if (keys.size !== imported.importedKeys.length || [...keys].some((key) => !inventory.sessions.some((entry) => entry.key === key))) {
        throw new Error('migration adapter returned unknown or duplicate catalog ownership');
      }
      await imported.verify();
      const sourceChecks = imported.sourceChecks ?? [];
      await verifySources(sourceChecks);
      if ((await inspectLegacySpaceState(paths)).digest !== inventory.digest
        || configRevision(await this.repository.readRoot()) !== baseRevision) throw new Error('profile changed during migration preparation');
      return writePreparation(paths.profileDir, {
        schema: 'aria.space.preparation.v1', id: preparationId, profileId: paths.profile,
        createdAt: new Date().toISOString(), baseRevision, executionFingerprint: fingerprint,
        original: { mode: config.mode }, deployment: definition,
        migration: { catalogDigest: inventory.digest, stateDigest: await stagedStateDigest(staging.state), sourceChecks, importedSessions: keys.size,
          sealedSessions: inventory.sessions.length - keys.size, verified: true },
      });
    });
  }

  /** Offline metadata upgrade: data and credential paths stay stable. The
   * immutable backup is for operator recovery, never an automatic data rewind. */
  async prepareUpgrade(profile: string, deployment: SpaceDeploymentDefinition, actor: ControlActorContext,
    preparationId = randomBytes(16).toString('hex')): Promise<ExecutionSpaceSelection> {
    return this.offline(profile, actor, async ({ config, paths, root }) => {
      if (!config.executionSpaces) throw new Error('an active preparation is required for upgrade');
      const previous = await readPreparation(paths.profileDir, config.executionSpaces);
      if (previous.profileId !== paths.profile) throw new Error('preparation profile mismatch');
      const definition = normalizeSpaceDeployment(deployment);
      if (definition.engineId !== config.agentKind || definition.workspaceAccess !== config.permissions.defaultAccess) {
        throw new Error('upgrade must preserve the current engine and access ceiling');
      }
      if (JSON.stringify(previous.deployment.templates) !== JSON.stringify(definition.templates)) throw new Error('native template changes require a separate verified data migration');
      const inventory = await inspectLegacySpaceState(paths);
      if (inventory.pendingWork) throw new Error('pending work must be settled before upgrade');
      const source = preparationStoragePaths(paths.profileDir, previous).state;
      const sourceDigest = await stagedStateDigest(source, { allowSymlinks: true });
      const staging = preparationPaths(paths.profileDir, preparationId);
      const baseRevision = configRevision(root), fingerprint = executionFingerprint(config);
      const backup = join(staging.directory, 'backup');
      const intent = { schema: 'aria.space.upgrade.v1', preparationId, baseRevision,
        previous: config.executionSpaces, sourceDigest, deployment: definition };
      await assertConfinedPath(paths.profileDir, staging.journal);
      await mkdir(staging.directory, { recursive: true, mode: 0o700 });
      try {
        if (JSON.stringify(await readPrivateJson(staging.journal)) !== JSON.stringify(intent)) throw new Error('upgrade inputs changed');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await writeFileAtomic(staging.journal, JSON.stringify(intent) + '\n', { mode: 0o600 });
      }
      await assertConfinedPath(paths.profileDir, backup);
      if (!await stat(backup).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
        const sourceExists = await stat(source).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        if (sourceExists) await cp(source, backup, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, dereference: false, verbatimSymlinks: true });
        else await mkdir(backup, { mode: 0o700 });
      }
      if (await stagedStateDigest(backup, { allowSymlinks: true }) !== sourceDigest || await stagedStateDigest(source, { allowSymlinks: true }) !== sourceDigest) {
        throw new Error('upgrade backup or source changed; preserve both for inspection');
      }
      try {
        const existing = await readPrivateJson(staging.receipt) as SpacePreparationReceipt;
        if (existing.id !== preparationId || existing.schema !== 'aria.space.preparation.v2') throw new Error('upgrade receipt identity changed');
        const selection = await writePreparation(paths.profileDir, existing);
        const checked = await readPreparation(paths.profileDir, selection);
        if (checked.baseRevision !== baseRevision || checked.migration.stateDigest !== sourceDigest
          || JSON.stringify(checked.deployment) !== JSON.stringify(definition)) throw new Error('completed upgrade changed');
        return selection;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const probe = resolveSpacePaths(join(staging.directory, 'probe'), { kind: 'default', profileId: paths.profile });
      await prepareSpacePaths(probe); await probeSpaceDeployment(definition, probe);
      if (configRevision(await this.repository.readRoot()) !== baseRevision || await stagedStateDigest(source, { allowSymlinks: true }) !== sourceDigest) {
        throw new Error('profile changed during upgrade');
      }
      return writePreparation(paths.profileDir, {
        schema: 'aria.space.preparation.v2', id: preparationId, profileId: paths.profile,
        createdAt: new Date().toISOString(), baseRevision, executionFingerprint: fingerprint,
        original: { mode: config.mode, executionSpaces: config.executionSpaces }, deployment: definition,
        storage: { preparationId: previous.storage?.preparationId ?? previous.id, backupDigest: sourceDigest },
        migration: { ...previous.migration, catalogDigest: inventory.digest, stateDigest: sourceDigest, sourceChecks: [], verified: true },
      });
    });
  }

  async inspectPreparation(profile: string, selection: ExecutionSpaceSelection, actor: ControlActorContext) {
    const { config, paths, root } = await this.target(profile, actor);
    const receipt = await readPreparation(paths.profileDir, selection);
    if (receipt.profileId !== paths.profile) throw new Error('preparation profile mismatch');
    return { schema: 'aria.space.preparation-summary.v1', profile: paths.profile, selection,
      driver: receipt.deployment.driver, engineId: receipt.deployment.engineId, binaryVersion: receipt.deployment.binaryVersion,
      importedSessions: receipt.migration.importedSessions, sealedSessions: receipt.migration.sealedSessions,
      nativeFiles: receipt.migration.sourceChecks.length, createdAt: receipt.createdAt,
      configurationCurrent: receipt.baseRevision === configRevision(root) && receipt.executionFingerprint === executionFingerprint(config),
      legacyCurrent: receipt.migration.catalogDigest === (await inspectLegacySpaceState(paths)).digest };
  }

  async activate(profile: string, selection: ExecutionSpaceSelection, actor: ControlActorContext, acceptSealedHistory = false) {
    return this.offline(profile, actor, async ({ config, root, paths }) => {
      const receipt = await readPreparation(paths.profileDir, selection);
      if (receipt.profileId !== paths.profile || receipt.executionFingerprint !== executionFingerprint(config)) throw new Error('preparation does not match this profile');
      if (JSON.stringify(config.executionSpaces) === JSON.stringify(selection)) return { changed: false, revision: configRevision(root) };
      if (receipt.migration.sealedSessions && !acceptSealedHistory) throw new Error('preparation contains sealed legacy history; review it with aria space inspect and explicitly accept sealed history');
      if (receipt.baseRevision !== configRevision(root)) throw new Error('configuration changed since preparation');
      if (receipt.migration.catalogDigest !== (await inspectLegacySpaceState(paths)).digest) throw new Error('legacy state changed since preparation');
      await verifySources(receipt.migration.sourceChecks);
      const staging = preparationStoragePaths(paths.profileDir, receipt);
      if (receipt.migration.stateDigest !== await stagedStateDigest(staging.state, { allowSymlinks: receipt.schema === 'aria.space.preparation.v2' })) throw new Error('staged state changed since preparation');
      if (receipt.storage) {
        const backup = join(staging.directory, 'backup');
        if (!(await stat(backup)).isDirectory() || await stagedStateDigest(backup, { allowSymlinks: true }) !== receipt.storage.backupDigest) {
          throw new Error('upgrade backup changed since preparation');
        }
      }
      const probePaths = resolveSpacePaths(join(staging.directory, 'probe'), { kind: 'default', profileId: paths.profile });
      await probeSpaceDeployment(receipt.deployment, probePaths);
      return this.commit(paths.profile, configRevision(root), 'team', selection, actor);
    });
  }

  /** Validate the immutable rollback destination while the current runtime is
   * still serving. The offline mutation repeats this check before committing. */
  async preflightRollback(profile: string, actor: ControlActorContext) {
    const { config, root, paths } = await this.target(profile, actor);
    if (config.executionSpaces) await this.rollbackTarget(paths, config.executionSpaces);
    if (configRevision(await this.repository.readRoot()) !== configRevision(root)) {
      throw new Error('configuration changed during rollback preflight');
    }
    return { revision: configRevision(root) };
  }

  private async rollbackTarget(paths: AppPaths, selection: ExecutionSpaceSelection) {
    const receipt = await readPreparation(paths.profileDir, selection);
    if (receipt.profileId !== paths.profile) throw new Error('preparation profile mismatch');
    if (receipt.original.executionSpaces) {
      const previous = await readPreparation(paths.profileDir, receipt.original.executionSpaces);
      if (previous.profileId !== paths.profile) throw new Error('preparation profile mismatch');
      if ((receipt.deployment.driver === 'execution' && previous.deployment.driver !== 'execution')
        || (receipt.deployment.tools?.larkCli.userAuthorization && !previous.deployment.tools?.larkCli.userAuthorization)) {
        throw new Error('rollback would weaken execution or personal identity isolation');
      }
      const probePaths = resolveSpacePaths(join(preparationStoragePaths(paths.profileDir, previous).directory, 'probe'), {
        kind: 'default', profileId: paths.profile,
      });
      await probeSpaceDeployment(previous.deployment, probePaths);
    }
    return receipt;
  }

  async rollback(profile: string, actor: ControlActorContext) {
    return this.offline(profile, actor, async ({ config, root, paths }) => {
      if (!config.executionSpaces) return { changed: false, revision: configRevision(root) };
      const receipt = await this.rollbackTarget(paths, config.executionSpaces);
      const inventory = await inspectLegacySpaceState(paths);
      if (inventory.pendingWork) throw new Error('active triggers or pending results must be paused or settled before rollback');
      const state = preparationStoragePaths(paths.profileDir, receipt).state;
      await assertConfinedPath(paths.profileDir, join(state, 'space-control'));
      await mkdir(join(state, 'space-control'), { recursive: true, mode: 0o700 });
      await SpaceReadAccess.invalidateRetained(join(state, 'space-control', 'read-access.v1.json'));
      await retainPreparation(paths.profileDir, { schema: 'aria.space.retained.v1', profileId: paths.profile,
        selection: config.executionSpaces, rolledBackAt: new Date().toISOString(), legacyDigest: inventory.digest });
      // Space-native state is retained. No reverse copy, flattening or deletion.
      return this.commit(paths.profile, configRevision(root), receipt.original.mode, receipt.original.executionSpaces, actor);
    });
  }

  /** Reuses the explicitly retained Team branch, including data created since
   * first activation. Legacy changes remain on their own branch and are reported;
   * re-enabling never silently creates a new empty Space or merges identities. */
  async reactivate(profile: string, selection: ExecutionSpaceSelection, actor: ControlActorContext, acceptLegacyDelta = false) {
    return this.offline(profile, actor, async ({ config, root, paths }) => {
      if (config.executionSpaces) throw new Error('a Team preparation is already active');
      const retained = (await retainedPreparations(paths.profileDir, paths.profile)).find(value =>
        JSON.stringify(value.selection) === JSON.stringify(selection));
      if (!retained) throw new Error('selection has no retained activation receipt');
      const receipt = await readPreparation(paths.profileDir, selection);
      if (receipt.profileId !== paths.profile || receipt.executionFingerprint !== executionFingerprint(config)) throw new Error('retained Team configuration no longer matches this profile');
      const inventory = await inspectLegacySpaceState(paths);
      if (inventory.pendingWork) throw new Error('legacy triggers must be paused or settled before reactivation');
      if (inventory.digest !== retained.legacyDigest && !acceptLegacyDelta) throw new Error('legacy changes require explicit review before reactivation; both histories are retained');
      const staging = preparationStoragePaths(paths.profileDir, receipt);
      const probePaths = resolveSpacePaths(join(staging.directory, 'probe'), { kind: 'default', profileId: paths.profile });
      await probeSpaceDeployment(receipt.deployment, probePaths);
      return this.commit(paths.profile, configRevision(root), 'team', selection, actor);
    });
  }

  private async target(profile: string, actor: ControlActorContext) {
    const paths = resolveAppPaths({ rootDir: this.rootDir, profile });
    if (!this.options.authorize(actor, paths.profile)) throw new ControlChangeError('operation-unavailable', 'space administration requires a trusted operator');
    const root = await this.repository.readRoot();
    const config = root?.profiles[paths.profile];
    if (!root || !config) throw new ControlChangeError('profile-not-found', 'profile not found');
    return { root, config, paths };
  }
  private async offline<T>(profile: string, actor: ControlActorContext,
    operation: (target: { root: RootConfig; config: ProfileConfig; paths: AppPaths }) => Promise<T>): Promise<T> {
    const first = await this.target(profile, actor);
    const lock = await acquireProfileRuntimeLock(first.paths, first.config.agentKind);
    try { return await operation(await this.target(profile, actor)); }
    finally { await lock.release(); }
  }
  private async commit(profile: string, baseRevision: string, mode: 'personal' | 'team',
    selection: ExecutionSpaceSelection | undefined, actor: ControlActorContext) {
    let ready = true;
    const api = new ManagementApi(new ConfigChangeService({ rootDir: this.rootDir, repository: this.repository,
      registry: new ManagementCommandRegistry([profileModeTransitionCommand]),
      authorizeCommand: (input) => ready && input.command.id === profileModeTransitionCommand.id
        && input.resource.kind === 'profile' && input.resource.profile === profile
        && input.actor.source === actor.source && input.actor.principal === actor.principal
        && this.options.authorize(input.actor, profile),
    }));
    try {
      const result = await api.execute({ schema: 'aria.management.execute.request.v1', apiVersion: MANAGEMENT_API_VERSION,
        requestId: randomUUID(), actor, command: profileModeTransitionCommand.id, profile,
        input: { baseRevision, mode, preparationId: selection?.preparationId ?? null, receiptDigest: selection?.receiptDigest ?? null } });
      return { changed: true, revision: result.applyResult.resultRevision, planId: result.planId, effect: result.effect };
    } finally { ready = false; }
  }
}

async function verifySources(checks: readonly { path: string; sha256: string }[]): Promise<void> {
  for (const check of checks) if ((await digestFile(check.path)).sha256 !== check.sha256) throw new Error('native source changed since preparation');
}
