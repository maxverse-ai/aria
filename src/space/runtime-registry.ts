import type { EngineRuntime, EngineRuntimeTopology } from '../agent/runtime/types';
import { RuntimeGeneration, type RuntimeAcquisition, type RuntimeLease, type RuntimeProvider } from '../runtime/runtime-provider';
import { SpaceAuthorization, type AuthorizedSpaceContext, type AuthorizedSpaceSnapshot } from './authorization';
import { principalId } from './identity';
import type { SpaceWorkspaces } from './workspace';

export interface SpaceRuntimeRegistryOptions {
  authorization: SpaceAuthorization;
  topology: EngineRuntimeTopology;
  create(context: AuthorizedSpaceSnapshot, signal: AbortSignal): Promise<EngineRuntime>;
  workspaces?: Pick<SpaceWorkspaces, 'prepare' | 'runInstructions' | 'close'>;
  maxResidentRuntimes?: number;
  maxDaemons?: number;
  maxWaiting?: number;
  maxPerPrincipal?: number;
  waitTimeoutMs?: number;
  idleMs?: number;
  crashBackoffMs?: number;
  startupTimeoutMs?: number;
  now?: () => number;
}
interface Entry {
  generation: number;
  creating: Promise<RuntimeGeneration>;
  owner?: RuntimeGeneration;
  lastUsedAt: number;
  closing: boolean;
  acquiring: number;
  startup?: Promise<void>;
}

/** One profile coordinator borrows runtimes here; this registry does not queue turns. */
export class SpaceRuntimeRegistry implements RuntimeProvider {
  private readonly entries = new Map<string, Entry>();
  private readonly failures = new Map<string, number>();
  private readonly principalUse = new Map<string, number>();
  private readonly waiters = new Set<() => void>();
  private readonly workspaceReady = new Set<string>();
  private readonly workspacePreparing = new Map<string, Promise<void>>();
  private readonly controller = new AbortController();
  private generation = 0;
  private closed = false;
  private disposal?: Promise<void>;
  private readonly idleTimer: NodeJS.Timeout;
  private readonly now: () => number;
  private readonly limits: Required<Pick<SpaceRuntimeRegistryOptions,
    'maxResidentRuntimes' | 'maxDaemons' | 'maxWaiting' | 'maxPerPrincipal' | 'waitTimeoutMs' | 'idleMs' | 'crashBackoffMs' | 'startupTimeoutMs'>>;

  constructor(private readonly options: SpaceRuntimeRegistryOptions) {
    this.now = options.now ?? Date.now;
    this.limits = {
      maxResidentRuntimes: options.maxResidentRuntimes ?? 128,
      maxDaemons: options.maxDaemons ?? 8, maxWaiting: options.maxWaiting ?? 128,
      maxPerPrincipal: options.maxPerPrincipal ?? 16, waitTimeoutMs: options.waitTimeoutMs ?? 5000,
      idleMs: options.idleMs ?? 60_000, crashBackoffMs: options.crashBackoffMs ?? 1000,
      startupTimeoutMs: options.startupTimeoutMs ?? 15_000,
    };
    for (const limit of Object.values(this.limits)) {
      if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('invalid runtime resource limit');
    }
    this.idleTimer = setInterval(() => {
      void this.evictIdle().catch(() => {
        // A failed native disposal leaves ownership uncertain. Fence admission
        // and retain the entry for shutdown instead of granting another slot.
        this.closed = true; this.controller.abort(); this.wake();
        clearInterval(this.idleTimer);
      });
    }, this.limits.idleMs);
    this.idleTimer.unref();
  }

  async acquire(input: RuntimeAcquisition): Promise<RuntimeLease> {
    if (!input.spaceContext) throw new Error('space runtime requires authorization');
    const context = this.options.authorization.inspect(input.spaceContext);
    if (input.scopeId !== context.executionScope) throw new Error('runtime scope mismatch');
    const space = context.binding.spaceId;
    const principal = principalId(context.principal);
    const deadline = Date.now() + this.limits.waitTimeoutMs;
    let instructions: string | undefined;
    let instructionsPrepared = false;
    let startupReplacements = 0;
    while (true) {
      this.assertOpen();
      this.options.authorization.inspect(input.spaceContext);
      if (this.options.workspaces) {
        const preparing = this.workspacePreparing.get(space);
        if (preparing) { await preparing; continue; }
        if (input.purpose === 'run' && !this.workspaceReady.has(space)) {
          const previous = this.entries.get(space);
          if (previous && (previous.acquiring > 0 || previous.closing || (previous.owner?.activeReferences ?? 0) > 0)) {
            await this.wait(deadline); continue;
          }
          // Fence queries while installing. Retire a query-created daemon so
          // its first execution discovers the newly installed skill set.
          const preparation = Promise.resolve().then(async () => {
            if (previous) await this.retire(space, previous);
            this.assertOpen(); this.options.authorization.inspect(input.spaceContext!);
            await this.options.workspaces!.prepare(input.spaceContext!);
            this.assertOpen(); this.workspaceReady.add(space);
          }).finally(() => { this.workspacePreparing.delete(space); this.wake(); });
          this.workspacePreparing.set(space, preparation);
          await preparation; continue;
        }
        if (input.purpose === 'run' && !instructionsPrepared) {
          instructions = await this.options.workspaces.runInstructions(input.spaceContext, input.runId ?? '');
          instructionsPrepared = true;
          continue;
        }
      }
      if ((this.failures.get(space) ?? 0) > this.now()) throw new Error('space runtime is backing off after failure');
      let entry = this.entries.get(space);
      if (entry?.owner?.runtime.isReusable?.() === false && !entry.closing) {
        if (entry.acquiring || entry.owner.activeReferences) { await this.wait(deadline); continue; }
        await this.retire(space, entry); continue;
      }
      if (!entry && this.atCapacity()) {
        const oldest = [...this.entries.entries()]
          .filter(([, value]) => value.owner && !value.closing && value.acquiring === 0 && value.owner.activeReferences === 0)
          .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
        if (oldest) { await this.retire(oldest[0], oldest[1]); continue; }
      }
      if ((!entry && this.atCapacity()) || entry?.closing
        || (this.principalUse.get(principal) ?? 0) >= this.limits.maxPerPrincipal) {
        await this.wait(deadline); continue;
      }
      if (!entry) {
        const generation = ++this.generation;
        const created: Entry = { generation, lastUsedAt: this.now(), closing: false, acquiring: 0, creating: undefined as never };
        this.entries.set(space, created);
        const startup = new AbortController();
        const signal = AbortSignal.any([startup.signal, this.controller.signal]);
        let expired = false;
        let timer: NodeJS.Timeout | undefined;
        const construction = Promise.resolve().then(() => this.options.create(context, signal)).then(async (runtime) => {
          const owner = new RuntimeGeneration(runtime, generation);
          created.owner = owner;
          if (runtime.descriptor.topology !== this.options.topology) {
            await owner.dispose(); throw new Error('runtime topology changed during creation');
          }
          if (this.closed || expired) { await owner.dispose(); throw new Error('space runtime startup canceled'); }
          return owner;
        });
        created.startup = construction.then(() => undefined, () => undefined).finally(() => {
          if (expired && this.entries.get(space) === created) this.entries.delete(space);
          this.wake();
        });
        created.creating = Promise.race([construction, new Promise<never>((_, reject) => {
          timer = setTimeout(() => { expired = true; created.closing = true; startup.abort(); reject(new Error('space runtime startup timeout')); }, this.limits.startupTimeoutMs);
        })]).finally(() => clearTimeout(timer)).catch((error) => {
          if (!expired && this.entries.get(space) === created) this.entries.delete(space);
          this.failures.set(space, this.now() + this.limits.crashBackoffMs);
          if (this.failures.size > this.limits.maxResidentRuntimes) this.failures.delete(this.failures.keys().next().value!);
          this.wake(); throw error;
        });
        entry = created;
      }
      // Reserve per-principal capacity before async creation, including queries.
      entry.acquiring++;
      this.principalUse.set(principal, (this.principalUse.get(principal) ?? 0) + 1);
      let inner: RuntimeLease;
      try {
        const owner = await entry.creating;
        this.assertOpen();
        this.options.authorization.inspect(input.spaceContext);
        if (owner.runtime.isReusable?.() === false) {
          // An environment can fail between creation and the first lease
          // (for example when a startup probe exits and fences its container).
          // Retire that generation here and retry this acquisition so one
          // transiently poisoned runtime does not strand the user request.
          if (entry.acquiring !== 1 || owner.activeReferences !== 0) {
            throw new Error('space runtime requires retirement');
          }
          await this.retire(space, entry);
          if (++startupReplacements > 1) {
            this.failures.set(space, this.now() + this.limits.crashBackoffMs);
            throw new Error('space runtime repeatedly unusable during startup');
          }
          this.releasePrincipal(principal);
          continue;
        }
        inner = owner.acquire();
      } catch (error) { this.releasePrincipal(principal); throw error; }
      finally { entry.acquiring--; }
      let released = false;
      const owned = entry;
      return Object.freeze({
        generation: inner.generation, runtime: inner.runtime,
        ...(instructions ? { instructions } : {}),
        get released() { return released; },
        release: () => {
          if (released) return;
          released = true; inner.release();
          owned.lastUsedAt = this.now(); this.releasePrincipal(principal);
        },
      });
    }
  }

  /** Only counters; listing never wakes a dormant engine or reveals live account data. */
  snapshot() {
    return { resident: this.entries.size, waiting: this.waiters.size,
      references: [...this.entries.values()].reduce((n, entry) => n + (entry.owner?.activeReferences ?? 0), 0),
      daemonSlots: this.options.topology === 'one-shot' ? 0 : this.entries.size, closed: this.closed };
  }
  async evictIdle(): Promise<void> {
    for (const [space, entry] of this.entries) {
      if (entry.owner && !entry.closing && entry.acquiring === 0 && entry.owner.activeReferences === 0 && this.now() - entry.lastUsedAt >= this.limits.idleMs) {
        await this.retire(space, entry);
      }
    }
  }
  dispose(): Promise<void> {
    if (!this.disposal) {
      clearInterval(this.idleTimer);
      this.closed = true; this.controller.abort(); this.wake();
      this.disposal = (async () => {
        await this.options.workspaces?.close();
        await Promise.allSettled([...this.workspacePreparing.values()]);
        await Promise.all([...this.entries].map(([space, entry]) => this.retire(space, entry)));
      })();
    }
    return this.disposal;
  }
  private async retire(space: string, entry: Entry): Promise<void> {
    entry.closing = true;
    let disposed = false;
    try {
      let owner: RuntimeGeneration;
      try { owner = await entry.creating; } catch { await entry.startup; disposed = true; return; }
      await owner.dispose();
      disposed = true;
    }
    finally { if (disposed && this.entries.get(space) === entry) this.entries.delete(space); this.wake(); }
  }
  private atCapacity(): boolean {
    return this.entries.size >= this.limits.maxResidentRuntimes
      || (this.options.topology !== 'one-shot' && this.entries.size >= this.limits.maxDaemons);
  }
  private assertOpen(): void { if (this.closed) throw new Error('space runtime registry is closed'); }
  private releasePrincipal(principal: string): void {
    const remaining = (this.principalUse.get(principal) ?? 1) - 1;
    if (remaining) this.principalUse.set(principal, remaining); else this.principalUse.delete(principal);
    this.wake();
  }
  private wake(): void { for (const wake of [...this.waiters]) wake(); }
  private wait(deadline: number): Promise<void> {
    if (Date.now() >= deadline) return Promise.reject(new Error('space runtime capacity timeout'));
    if (this.waiters.size >= this.limits.maxWaiting) return Promise.reject(new Error('space runtime queue is full'));
    return new Promise<void>((resolve, reject) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(() => { this.waiters.delete(done); reject(new Error('space runtime capacity timeout')); }, deadline - Date.now());
      this.waiters.add(done);
    });
  }
}

export function spaceRuntimeRequest(context: AuthorizedSpaceContext, authorization: SpaceAuthorization, purpose: 'run' | 'query'): RuntimeAcquisition {
  return { scopeId: authorization.inspect(context).executionScope, spaceContext: context, purpose };
}
