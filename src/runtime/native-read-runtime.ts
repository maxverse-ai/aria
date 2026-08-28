import type { AppPaths } from '../config/app-paths';
import type { SessionCatalog } from '../session/catalog';
import { NativeAuditRecorder } from '../application/control/native-audit-recorder';
import { NativeRunAuditSink } from '../application/control/native-run-audit-sink';
import { NativeMessageAuditSink } from '../application/control/native-message-audit-sink';
import { NativeMessageReadProjector } from '../application/control/native-message-read-projector';
import { NativeGovernanceAuditSink } from '../application/control/native-governance-audit-sink';
import { SessionCatalogReadProjector } from '../application/control/session-catalog-read-projector';
import { FileNativeReadRepository } from '../platform/file-native-read-repository';
import {
  startNativeReadHttpServer,
  type NativeReadHttpServerHandle,
  type NativeReadScope,
} from '../platform/native-read-http-server';

export interface NativeReadProfileRuntime {
  readonly audit: NativeAuditRecorder;
  readonly runAudit: NativeRunAuditSink;
  readonly messageAudit: NativeMessageAuditSink;
  readonly messageRead: NativeMessageReadProjector;
  readonly governanceAudit: NativeGovernanceAuditSink;
  start(): Promise<void>;
  refreshSessions(): Promise<void>;
  stop(): Promise<void>;
}

export interface NativeReadRuntimeFactoryContext {
  profile: string;
  appPaths: AppPaths;
  sessionCatalog: SessionCatalog;
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
  readonly audit: NativeAuditRecorder;
  readonly runAudit: NativeRunAuditSink;
  readonly messageAudit: NativeMessageAuditSink;
  readonly messageRead: NativeMessageReadProjector;
  readonly governanceAudit: NativeGovernanceAuditSink;
  private readonly repository: FileNativeReadRepository;
  private readonly sessions: SessionCatalogReadProjector;
  private server?: NativeReadHttpServerHandle;
  private lifecycle: Promise<void> = Promise.resolve();

  constructor(private readonly options: NativeReadProfileRuntimeOptions) {
    if (!options.token) throw new Error('native read runtime token is required');
    this.repository = new FileNativeReadRepository({
      profileId: options.profileId,
      snapshotFile: options.appPaths.nativeReadSnapshotFile,
      journalFile: options.appPaths.nativeReadJournalFile,
    });
    this.sessions = new SessionCatalogReadProjector({
      profileId: options.profileId,
      repository: this.repository,
    });
    this.audit = new NativeAuditRecorder({
      profileId: options.profileId,
      repository: this.repository,
    });
    this.runAudit = new NativeRunAuditSink({
      profileId: options.profileId,
      recorder: this.audit,
      repository: this.repository,
    });
    this.messageAudit = new NativeMessageAuditSink(options.profileId, this.audit);
    this.messageRead = new NativeMessageReadProjector({ profileId: options.profileId, repository: this.repository });
    this.governanceAudit = new NativeGovernanceAuditSink(options.profileId, this.audit);
  }

  start(): Promise<void> {
    return this.serialize(async () => {
      if (this.server) return;
      await this.repository.initialize();
      await this.projectSessions();
      this.server = await startNativeReadHttpServer({
        endpoint: this.options.appPaths.nativeReadEndpoint,
        token: this.options.token,
        scopes: this.options.scopes,
        repository: this.repository,
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
      await server?.close();
    });
  }

  private async projectSessions(): Promise<void> {
    await this.sessions.project({ entries: this.options.sessionCatalog.entries() });
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(operation, operation);
    this.lifecycle = next.catch(() => undefined);
    return next;
  }
}
