import { readPreparation } from './preparation-store';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { ControlActorContext } from '../application/control/change-types';
import type { ExecutionSpaceSelection } from '../config/execution-spaces';
import { resolveAppPaths } from '../config/app-paths';
import { writeFileAtomic } from '../platform/atomic-write';
import { assertConfinedPath } from './paths';
import { normalizeSpaceDeployment, readPrivateJson, type SpaceDeploymentDefinition } from './deployment';
import { SpaceManagementService } from './management';

/** Installed composition owns process control. Drain must fence new ingress and
 * wait for admitted work, with a bounded timeout and no forced task loss. */
export interface SpaceTransitionRuntime {
  running(profile: string): Promise<boolean>;
  drain(profile: string, timeoutMs: number): Promise<void>;
  stop(profile: string): Promise<void>;
  start(profile: string): Promise<void>;
  /** Starts stay fenced while a transition journal is pending. */
  resume(profile: string): Promise<void>;
  healthy(profile: string, timeoutMs: number): Promise<void>;
}
type Phase = 'draining' | 'stopped' | 'preparing' | 'prepared' | 'activating' | 'starting' | 'healthy' | 'restoring' | 'rolled-back' | 'aborted' | 'recovery-required';
interface TransitionJournal {
  schema: 'aria.space.transition.v1'; id: string; profile: string; operation: 'enable' | 'rollback' | 'reactivate' | 'upgrade';
  phase: Phase; startedAt: string; updatedAt: string; wasRunning: boolean; baseRevision: string;
  originalMode?: 'personal' | 'team';
  originalSelection?: ExecutionSpaceSelection; selection?: ExecutionSpaceSelection;
  importedSessions?: number; sealedSessions?: number;
}
const terminal = (phase: Phase) => phase === 'healthy' || phase === 'rolled-back' || phase === 'aborted';

/** One durable transition owner, shared by CLI and hosting consoles. Desired
 * state mutations remain in SpaceManagementService; this class owns only the
 * stop/prepare/start transaction and its explicit recovery exits. */
export class SpaceTransitionCoordinator {
  constructor(private readonly input: { rootDir: string; management: SpaceManagementService; runtime: SpaceTransitionRuntime }) {}

  async status(profile: string, actor: ControlActorContext) {
    const status = await this.input.management.status(profile, actor);
    const journal = await this.read(profile);
    return { status, transition: journal ? this.summary(journal) : undefined, recoveryRequired: journal ? !terminal(journal.phase) : false };
  }

  async reactivate(profile: string, selection: ExecutionSpaceSelection, actor: ControlActorContext,
    options: { acceptLegacyDelta?: boolean; drainTimeoutMs?: number; healthTimeoutMs?: number } = {}) {
    await this.input.management.status(profile, actor);
    const paths = resolveAppPaths({ rootDir: this.input.rootDir, profile });
    const receipt = await readPreparation(paths.profileDir, selection);
    return this.enable(profile, receipt.deployment, actor, { ...options, retainedSelection: selection, acceptSealedHistory: true });
  }

  async preflight(profile: string, deployment: SpaceDeploymentDefinition, actor: ControlActorContext,
    operation: 'enable' | 'upgrade' = 'enable') {
    const status = await this.input.management.status(profile, actor);
    const definition = normalizeSpaceDeployment(deployment);
    const journal = await this.read(profile);
    return { schema: 'aria.space.transition-preflight.v1', operation, status, deployment: {
      engineId: definition.engineId, binaryVersion: definition.binaryVersion, driver: definition.driver,
      nativeTools: definition.tools ? ['lark-cli'] : [], userAuthorization: definition.tools?.larkCli.userAuthorization ?? false,
    }, legacyPolicy: 'preserve-originals-and-seal-unattributed',
    readyToAttempt: status.legacy.pendingWork === 0 && (operation === 'upgrade' ? Boolean(status.selection)
      : !status.selection && status.retained.length === 0) && (!journal || terminal(journal.phase)),
    ...(journal ? { transition: this.summary(journal) } : {}),
    note: 'Native startup and migrated-session proof are checked after draining; readyToAttempt is not platform acceptance.' };
  }

  async upgrade(profile: string, deployment: SpaceDeploymentDefinition, actor: ControlActorContext,
    options: { drainTimeoutMs?: number; healthTimeoutMs?: number } = {}) {
    return this.enable(profile, deployment, actor, { ...options, upgrade: true, acceptSealedHistory: true });
  }

  async enable(profile: string, deployment: SpaceDeploymentDefinition, actor: ControlActorContext,
    options: { acceptSealedHistory?: boolean; drainTimeoutMs?: number; healthTimeoutMs?: number; retainedSelection?: ExecutionSpaceSelection; acceptLegacyDelta?: boolean; upgrade?: boolean } = {}) {
    // Authenticate before taking any operator lock or calling a lifecycle port.
    await this.input.management.status(profile, actor);
    const definition = normalizeSpaceDeployment(deployment);
    return this.exclusive(profile, async () => {
      const before = await this.input.management.status(profile, actor);
      if (options.upgrade) {
        if (!before.selection || options.retainedSelection) throw new Error('upgrade requires the current active preparation');
      } else if (before.selection) throw new Error('team is already selected; use upgrade to change its runtime');
      const previous = await this.read(profile);
      if (previous && !terminal(previous.phase)) throw new Error('an interrupted space transition requires recovery');
      if (before.legacy.pendingWork) throw new Error('legacy triggers must be drained or paused before switching');
      if (!options.upgrade && before.retained.length && !options.retainedSelection) throw new Error('retained Team history exists; reactivate its selection instead of creating an empty replacement');
      const journal = await this.begin(profile, options.upgrade ? 'upgrade' : options.retainedSelection ? 'reactivate' : 'enable', before);
      try {
        await this.input.runtime.drain(profile, bounded(options.drainTimeoutMs, 60_000));
        await this.input.runtime.stop(profile);
        await this.phase(journal, 'stopped');
        await this.phase(journal, 'preparing');
        journal.selection = options.retainedSelection ?? (options.upgrade
          ? await this.input.management.prepareUpgrade(profile, definition, actor, journal.id)
          : await this.input.management.prepare(profile, definition, actor, journal.id));
        const review = await this.input.management.inspectPreparation(profile, journal.selection, actor);
        journal.importedSessions = review.importedSessions; journal.sealedSessions = review.sealedSessions;
        await this.phase(journal, 'prepared');
        if (review.sealedSessions && !options.acceptSealedHistory) throw new Error('sealed history needs explicit acceptance; originals are preserved');
        await this.phase(journal, 'activating');
        if (options.retainedSelection) await this.input.management.reactivate(profile, journal.selection, actor, options.acceptLegacyDelta);
        else await this.input.management.activate(profile, journal.selection, actor, options.acceptSealedHistory);
        await this.phase(journal, 'starting');
        await this.input.runtime.start(profile);
        await this.input.runtime.healthy(profile, bounded(options.healthTimeoutMs, 60_000));
        await this.input.runtime.resume(profile);
        await this.phase(journal, 'healthy');
        return this.summary(journal);
      } catch (error) {
        try { await this.restore(journal, actor); }
        catch { await this.phase(journal, 'recovery-required'); throw new Error('space transition failed and recovery requires the installed runtime owner; run transition recovery before retrying', { cause: error }); }
        throw new Error('space transition failed; original mode and prior running state restored, all data retained: ' + (error instanceof Error ? error.message : 'unknown error'), { cause: error });
      }
    });
  }

  async rollback(profile: string, actor: ControlActorContext, timeoutMs = 60_000) {
    await this.input.management.status(profile, actor);
    return this.exclusive(profile, async () => {
      const before = await this.input.management.status(profile, actor);
      const previous = await this.read(profile);
      if (previous && !terminal(previous.phase)) throw new Error('an interrupted space transition requires recovery');
      if (!before.selection) return { changed: false, mode: before.mode };
      const checked = await this.input.management.preflightRollback(profile, actor);
      if (checked.revision !== before.revision) throw new Error('configuration changed before rollback');
      const journal = await this.begin(profile, 'rollback', before);
      try {
        await this.input.runtime.drain(profile, bounded(timeoutMs, 60_000));
        await this.input.runtime.stop(profile); await this.phase(journal, 'stopped');
        await this.phase(journal, 'restoring');
        await this.input.management.rollback(profile, actor);
        if (journal.wasRunning) {
          await this.phase(journal, 'starting'); await this.input.runtime.start(profile);
          await this.input.runtime.healthy(profile, bounded(timeoutMs, 60_000));
          await this.input.runtime.resume(profile);
        }
        await this.phase(journal, 'rolled-back'); return this.summary(journal);
      } catch (error) {
        if (journal.phase === 'draining') {
          await this.input.runtime.resume(profile); await this.phase(journal, 'aborted'); throw error;
        }
        await this.phase(journal, 'recovery-required');
        throw new Error('rollback interrupted; space state is retained and transition recovery can finish restoring the original mode', { cause: error });
      }
    });
  }

  async recover(profile: string, actor: ControlActorContext) {
    await this.input.management.status(profile, actor);
    return this.exclusive(profile, async () => {
      const journal = await this.read(profile);
      if (!journal || terminal(journal.phase)) return { changed: false };
      try { await this.restore(journal, actor); return this.summary(journal); }
      catch (error) { await this.phase(journal, 'recovery-required'); throw error; }
    });
  }

  private async restore(journal: TransitionJournal, actor: ControlActorContext) {
    const current = await this.input.management.status(journal.profile, actor);
    const source = journal.operation === 'rollback' ? journal.originalSelection : journal.selection;
    const paths = resolveAppPaths({ rootDir: this.input.rootDir, profile: journal.profile });
    const receipt = source ? await readPreparation(paths.profileDir, source) : undefined;
    if (receipt && receipt.profileId !== journal.profile) throw new Error('preparation profile mismatch');
    // An immutable receipt proves the destination even if the process died
    // after the config commit but before the next journal write. Recovery must
    // never roll an already restored selection back another generation.
    const destination = receipt?.original ?? {
      mode: journal.originalMode ?? (journal.originalSelection ? 'team' : undefined),
      executionSpaces: journal.originalSelection,
    };
    if (!destination.mode && current.revision === journal.baseRevision) destination.mode = current.mode;
    const sameSelection = (a?: ExecutionSpaceSelection, b?: ExecutionSpaceSelection) => JSON.stringify(a) === JSON.stringify(b);
    const atDestination = current.mode === destination.mode && sameSelection(current.selection, destination.executionSpaces);
    const atSource = Boolean(source) && current.mode === 'team' && sameSelection(current.selection, source);
    if (!atSource && !atDestination) throw new Error('profile changed ownership during transition; recovery cannot overwrite it');
    if (journal.phase === 'draining') {
      await this.input.runtime.resume(journal.profile);
      await this.phase(journal, 'aborted'); return;
    }
    await this.phase(journal, 'restoring');
    if (await this.input.runtime.running(journal.profile)) await this.input.runtime.drain(journal.profile, 60_000);
    await this.input.runtime.stop(journal.profile);
    if (atSource && !atDestination) await this.input.management.rollback(journal.profile, actor);
    if (journal.wasRunning) {
      await this.input.runtime.start(journal.profile);
      await this.input.runtime.healthy(journal.profile, 60_000);
      await this.input.runtime.resume(journal.profile);
    }
    await this.phase(journal, 'rolled-back');
  }
  private async begin(profile: string, operation: TransitionJournal['operation'], before: Awaited<ReturnType<SpaceManagementService['status']>>) {
    const time = new Date().toISOString();
    const journal: TransitionJournal = { schema: 'aria.space.transition.v1', id: randomBytes(16).toString('hex'), profile,
      operation, phase: 'draining', startedAt: time, updatedAt: time, baseRevision: before.revision,
      originalMode: before.mode, wasRunning: await this.input.runtime.running(profile), ...(before.selection ? { originalSelection: before.selection } : {}) };
    await this.save(journal); return journal;
  }
  private summary(journal: TransitionJournal) {
    return { schema: journal.schema, id: journal.id, profile: journal.profile, operation: journal.operation,
      phase: journal.phase, startedAt: journal.startedAt, updatedAt: journal.updatedAt,
      importedSessions: journal.importedSessions ?? 0, sealedSessions: journal.sealedSessions ?? 0,
      originalsRetained: true, newStateRetained: true };
  }
  private async phase(journal: TransitionJournal, phase: Phase) { journal.phase = phase; journal.updatedAt = new Date().toISOString(); await this.save(journal); }
  private directory(profile: string) { return join(resolveAppPaths({ rootDir: this.input.rootDir, profile }).profileDir, 'space-control'); }
  private async read(profile: string): Promise<TransitionJournal | undefined> {
    let journal: TransitionJournal;
    try { journal = await readPrivateJson(join(this.directory(profile), 'transition.v1.json'), this.directory(profile)) as TransitionJournal; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    if (journal.schema !== 'aria.space.transition.v1' || journal.profile !== profile || !/^[a-f0-9]{32}$/.test(journal.id)
      || !['enable', 'rollback', 'reactivate', 'upgrade'].includes(journal.operation) || !['draining', 'stopped', 'preparing', 'prepared', 'activating', 'starting', 'healthy', 'restoring', 'rolled-back', 'aborted', 'recovery-required'].includes(journal.phase)
      || (journal.originalMode !== undefined && !['personal', 'team'].includes(journal.originalMode))
      || typeof journal.wasRunning !== 'boolean' || typeof journal.baseRevision !== 'string') throw new Error('invalid space transition journal');
    return journal;
  }
  private async save(journal: TransitionJournal) {
    const directory = this.directory(journal.profile);
    await writeFileAtomic(join(directory, 'transition.v1.json'), JSON.stringify(journal) + '\n', { mode: 0o600 });
    if (terminal(journal.phase)) {
      const history = join(directory, 'transitions'); await assertConfinedPath(directory, history);
      await mkdir(history, { recursive: true, mode: 0o700 });
      await writeFileAtomic(join(history, journal.id + '.json'), JSON.stringify(journal) + '\n', { mode: 0o600 });
    }
  }
  private async exclusive<T>(profile: string, work: () => Promise<T>): Promise<T> {
    const directory = this.directory(profile); await assertConfinedPath(this.input.rootDir, directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, 'transition-owner'); await assertConfinedPath(directory, target);
    await writeFile(target, '', { flag: 'a', mode: 0o600 });
    const release = await lockfile.lock(target, { realpath: false, stale: 30_000, update: 10_000 });
    try { return await work(); } finally { await release(); }
  }
}
/** Startup consumes only a host-owned journal; user/model inputs cannot lift
 * this fence. The installed transition owner explicitly resumes after health. */
export async function pendingSpaceTransition(profileDirectory: string): Promise<boolean> {
  let value: TransitionJournal;
  try { value = await readPrivateJson(join(profileDirectory, 'space-control', 'transition.v1.json'), join(profileDirectory, 'space-control')) as TransitionJournal; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (value.schema !== 'aria.space.transition.v1' || typeof value.phase !== 'string') throw new Error('invalid transition startup fence');
  return !terminal(value.phase);
}
function bounded(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1000 || value > 300_000) throw new Error('invalid transition timeout');
  return value;
}
