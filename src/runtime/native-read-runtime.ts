import type { AppPaths } from '../config/app-paths';
import type { SessionCatalog } from '../session/catalog';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { log } from '../core/logger';
import type { NativeReadChange } from '../application/control/native-read-types';
import type { MessageResourceSink } from './message-resource';
import type { PreparedSpaceProfile } from '../space/profile';
import type { NativeReadRepository } from '../application/control/native-read-repository';
import { activeNativeReadRepository, activeNativeMessageSink } from '../space/active-native-read';
import type { IncomingMessage } from 'node:http';
import { NativeAuditRecorder } from '../application/control/native-audit-recorder';
import { NativeRunAuditSink } from '../application/control/native-run-audit-sink';
import { NativeMessageAuditSink } from '../application/control/native-message-audit-sink';
import { NativeMessageReadProjector } from '../application/control/native-message-read-projector';
import { NativeGovernanceAuditSink } from '../application/control/native-governance-audit-sink';
import { SessionCatalogReadProjector } from '../application/control/session-catalog-read-projector';
import { FileNativeReadRepository } from '../platform/file-native-read-repository';
import { ManagementReadModel, observeNativeRepository } from '../application/control/management-read-model';
import { bootstrapManagementRead } from '../platform/management-read-bootstrap';
import {
  startNativeReadHttpServer,
  type NativeReadHttpServerHandle,
  type NativeReadScope,
} from '../platform/native-read-http-server';

export interface NativeReadProfileRuntime {
  readonly scope?: 'profile' | 'space';
  readonly audit: NativeAuditRecorder;
  readonly runAudit: NativeRunAuditSink;
  readonly messageAudit: NativeMessageAuditSink;
  readonly messageRead: MessageResourceSink;
  readonly governanceAudit: NativeGovernanceAuditSink;
  start(): Promise<void>;
  refreshSessions(): Promise<void>;
  stop(): Promise<void>;
}

export interface NativeReadRuntimeFactoryContext {
  profile: string;
  appPaths: AppPaths;
  sessionCatalog: SessionCatalog;
  spaces?: PreparedSpaceProfile;
}

export type NativeReadRuntimeFactory = (
  context: NativeReadRuntimeFactoryContext,
) => NativeReadProfileRuntime | Promise<NativeReadProfileRuntime>;

export interface NativeReadProfileRuntimeOptions {
  profileId: string;
  appPaths: Pick<
    AppPaths,
    'nativeReadSnapshotFile' | 'nativeReadJournalFile' | 'nativeReadEndpoint'
  >;
  sessionCatalog: Pick<SessionCatalog, 'entries'>;
  token: string;
  scopes: readonly NativeReadScope[];
  serverVersion: string;
  instanceId?: string;
  /** Public verification key only. No management signing secret enters Aria. */
  managementPublicKey?: string;
  spaces?: PreparedSpaceProfile;
  /** Trusted host controller must authenticate and refresh an original binding. */
  spaceRepository?: (request: IncomingMessage) => Promise<NativeReadRepository>;
}

/**
 * Owns the normalized read model and local API for one live profile.
 *
 * Construction has no side effects. Callers must opt in and provide the
 * bearer token explicitly; the default Supervisor composition does neither.
 * Agent-native stores are only observed through the supplied SessionCatalog
 * and are never moved, rewritten or used as the API's persistence layer.
 */
export class DefaultNativeReadProfileRuntime implements NativeReadProfileRuntime {
  readonly scope: 'profile' | 'space';
  readonly audit: NativeAuditRecorder;
  readonly runAudit: NativeRunAuditSink;
  readonly messageAudit: NativeMessageAuditSink;
  readonly messageRead: MessageResourceSink;
  readonly governanceAudit: NativeGovernanceAuditSink;
  private readonly repository: FileNativeReadRepository;
  private readonly sessions: SessionCatalogReadProjector;
  private readonly management?: ManagementReadModel;
  private readonly managementAudit?: NativeAuditRecorder;
  private managementReady = false;
  private managementFailed = false;
  private pendingMirrors = 0;
  private managementBootstrap?: Promise<void>;
  private stopObserving?: () => void;
  private server?: NativeReadHttpServerHandle;
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(private readonly options: NativeReadProfileRuntimeOptions) {
    this.scope = options.spaces ? 'space' : 'profile';
    if (!options.token) throw new Error('native read runtime token is required');
    this.repository = new FileNativeReadRepository({
      profileId: options.profileId,
      snapshotFile: options.spaces ? join(options.spaces.stateDirectory, 'space-control', 'read-api', 'snapshot.json') : options.appPaths.nativeReadSnapshotFile,
      journalFile: options.spaces ? join(options.spaces.stateDirectory, 'space-control', 'read-api', 'journal.jsonl') : options.appPaths.nativeReadJournalFile,
    });
    if (options.managementPublicKey) {
      const directory = options.spaces ? join(options.spaces.stateDirectory, 'space-control', 'management-read')
        : join(dirname(options.appPaths.nativeReadSnapshotFile), 'management-read');
      this.management = new ManagementReadModel(new FileNativeReadRepository({ profileId: options.profileId,
        snapshotFile: join(directory, 'snapshot.json'), journalFile: join(directory, 'journal.jsonl'), snapshotEvery: 250 }));
      // Keep access attempts out of the change feed they observe, avoiding a
      // self-triggering SSE refresh loop. No request payload or signature persists.
      this.managementAudit = new NativeAuditRecorder({ profileId: options.profileId,
        repository: new FileNativeReadRepository({ profileId: options.profileId,
          snapshotFile: join(directory, 'access-audit.snapshot.json'), journalFile: join(directory, 'access-audit.journal.jsonl'), snapshotEvery: 250 }) });
    }
    const writes = options.spaces ? activeNativeReadRepository(options.spaces)
      : this.management ? observeNativeRepository(this.repository, async change => this.mirror('legacy', change)) : this.repository;
    this.sessions = new SessionCatalogReadProjector({
      profileId: options.profileId,
      repository: writes,
    });
    this.audit = new NativeAuditRecorder({
      profileId: options.profileId,
      repository: writes,
    });
    this.runAudit = new NativeRunAuditSink({
      profileId: options.profileId,
      recorder: this.audit,
      repository: writes,
    });
    this.messageAudit = new NativeMessageAuditSink(options.profileId, this.audit);
    this.messageRead = options.spaces ? activeNativeMessageSink(options.spaces)
      : new NativeMessageReadProjector({ profileId: options.profileId, repository: writes });
    this.governanceAudit = new NativeGovernanceAuditSink(options.profileId, this.audit);
  }

  start(): Promise<void> {
    return this.serialize(async () => {
      if (this.server) return;
      await this.repository.initialize();
      await this.projectSessions();
      if (this.management) {
        this.stopObserving = this.options.spaces?.reads.observeCommitted(async (partition, change) => this.mirror(partition, change));
        // A large history bootstrap must not delay Bot readiness. Management
        // requests fail explicitly until reconciliation completes.
        this.managementBootstrap = bootstrapManagementRead(this.management, { profileId: this.options.profileId,
            directory: this.options.spaces?.stateDirectory,
            legacy: { snapshotFile: this.options.appPaths.nativeReadSnapshotFile, journalFile: this.options.appPaths.nativeReadJournalFile } })
          .then(() => { this.managementReady = !this.managementFailed; })
          .catch(() => this.failManagement());
      }
      this.server = await startNativeReadHttpServer({
        endpoint: this.options.appPaths.nativeReadEndpoint,
        token: this.options.token,
        scopes: this.options.scopes,
        repository: this.repository,
        ...(this.management ? { management: { publicKey: this.options.managementPublicKey!, model: this.management,
          available: () => this.managementReady,
          recordReadAttempt: async () => { await this.managementAudit!.record({ eventId: randomUUID(), action: 'read.performed',
            actor: { kind: 'system' }, outcome: 'unknown', target: { resourceType: 'profile' }, redacted: true }); },
        } } : {}),
        ...(this.options.spaces ? { allowUnscopedMetadata: true,
          spaceRepository: async (request: IncomingMessage) => {
            const token = request.headers['x-aria-space-read-token'];
            const repository = this.options.spaceRepository
              ? await this.options.spaceRepository(request)
              : await this.options.spaces!.readAccess.repository(typeof token === 'string' ? token : '');
            this.options.spaces!.reads.assertRepository(repository);
            return repository;
          } } : {}),
        serverVersion: this.options.serverVersion,
        ...(this.options.instanceId ? { instanceId: this.options.instanceId } : {}),
      });
    });
  }

  refreshSessions(): Promise<void> {
    return this.serialize(async () => {
      await this.repository.initialize();
      await this.projectSessions();
    });
  }

  stop(): Promise<void> {
    return this.serialize(async () => {
      const server = this.server;
      this.server = undefined;
      this.stopObserving?.(); this.stopObserving = undefined;
      await server?.close();
      await this.managementBootstrap;
      await this.management?.flush();
    });
  }

  private async projectSessions(): Promise<void> {
    if (this.options.spaces) return;
    await this.sessions.project({ entries: this.options.sessionCatalog.entries() });
  }

  private mirror(partition: string, change: NativeReadChange): void {
    if (this.managementFailed) return;
    // Bounded asynchronous side effect: never strand a source write, message,
    // or running agent on management-index I/O. Sources retain replay evidence.
    if (this.pendingMirrors >= 1000) { this.failManagement(); return; }
    this.pendingMirrors++;
    void this.management!.accept(partition, change).catch(() => this.failManagement())
      .finally(() => { this.pendingMirrors--; });
  }
  private failManagement(): void {
    this.managementReady = false;
    if (!this.managementFailed) log.warn('native-read', 'management.index-unavailable', { profileId: this.options.profileId });
    this.managementFailed = true;
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(operation, operation);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }
}
