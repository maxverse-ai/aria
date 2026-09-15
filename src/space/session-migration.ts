import { createExecutionBackend } from '../execution/configuration';
import { opaqueId } from './identity';
import { join } from 'node:path';
import { requireEnginePlugin } from '../agent/plugin/registry';
import type { NativeSessionSource } from '../agent/runtime/session-import';
import type { SessionCatalogEntry } from '../session/catalog';
import { evaluateRunPolicy, type ScopeContext } from '../policy/run-policy';
import type { SpaceMigrationAdapter } from './management';
import { PreparedSpaceProfile } from './profile';
import { SpaceAuthorization, type AuthorizedSpaceContext } from './authorization';
import { readPrivateJson, resolveSpaceDeployment } from './deployment';
import { spacePolicyProfile } from './policy-profile';
import { seedNativeTemplates } from './native-templates';
import { withConfinedLaunch } from './launch';
import { writeFileAtomic } from '../platform/atomic-write';

export interface VerifiedLegacySession {
  context: AuthorizedSpaceContext;
  scope: ScopeContext;
  nativeSource: NativeSessionSource;
  /** Digest of host-retained historical ownership evidence, not current roster alone. */
  evidenceDigest: string;
}
export interface LegacySessionOwnership {
  resolve(input: { profileId: string; entry: SessionCatalogEntry; authorization: SpaceAuthorization }): Promise<VerifiedLegacySession | undefined>;
}

/** Channel-independent orchestration. Unknown history and engines without an
 * explicit native importer remain sealed in their original storage. */
export function nativeSessionMigration(ownership: LegacySessionOwnership): SpaceMigrationAdapter {
  return { prepare: async (input) => {
    const plugin = requireEnginePlugin(input.profile.agentKind);
    if (!plugin.importSessions) return { importedKeys: [], verify: async () => {} };
    const deployment = resolveSpaceDeployment(input.deployment);
    const executionBackend = input.deployment.execution ? createExecutionBackend(input.deployment.execution) : undefined;
    const profile = { ...input.profile, mode: 'team' as const };
    const prepared = await PreparedSpaceProfile.create({ profileId: input.profileId, profile,
      directory: input.directory, deployment, executionBackend });
    const services = prepared.services;
    const groups = new Map<string, { entry: SessionCatalogEntry; proof: VerifiedLegacySession }[]>();
    const importedKeys: string[] = [];
    const sourceChecks: { path: string; sha256: string }[] = [];
    const persisted: { catalogFile: string; sessionsFile: string; key: string; scope: string; nativeId: string; cwd: string }[] = [];
    try {
      for (const entry of input.inventory.sessions) {
        if (entry.agentId !== plugin.id || entry.status !== 'active') continue;
        const nativeId = entry.threadId ?? entry.sessionId;
        if (!nativeId || input.inventory.sessions.filter((other) =>
          other.agentId === entry.agentId && (other.threadId ?? other.sessionId) === nativeId).length !== 1) continue;
        const proof = await ownership.resolve({ profileId: input.profileId, entry, authorization: services.authorization });
        if (!proof) continue;
        const snapshot = services.authorization.inspect(proof.context);
        if (snapshot.scopeRef !== entry.scopeId || snapshot.principal.subjectId !== proof.scope.actorId
          || snapshot.binding.key.kind === 'default' || proof.nativeSource.nativeId !== nativeId
          || !/^[a-f0-9]{64}$/.test(proof.evidenceDigest)) throw new Error('legacy ownership proof does not match the session');
        const group = groups.get(snapshot.binding.spaceId) ?? [];
        group.push({ entry, proof }); groups.set(snapshot.binding.spaceId, group);
      }
      for (const entries of groups.values()) {
        const first = entries[0]!;
        const state = await services.state.view(first.proof.context);
        await seedNativeTemplates(state.paths, deployment.templates ?? []);
        const environment = await executionBackend?.open({
          key: opaqueId('space-execution', [input.profileId, state.paths.spaceId]), revision: deployment.binaryVersion,
          cwd: state.paths.workspace, workingRoots: [state.paths.engine],
          mounts: [{ source: state.paths.engine, target: state.paths.engine, writable: true }],
        });
        let receipt: Awaited<ReturnType<NonNullable<typeof plugin.importSessions>>>;
        try { receipt = await plugin.importSessions({ sources: entries.map(({ proof }) => proof.nativeSource),
          binary: deployment.binary, profile, workspace: state.paths.workspace, home: state.paths.home,
          stateDirectory: state.paths.engine,
          withLaunch: (operation) => withConfinedLaunch({ ...deployment.launch, binary: deployment.binary, paths: state.paths,
            ...(environment ? { executionEnvironment: environment } : {}) }, operation) });
        } finally { await environment?.close(); }
        if (receipt.engineId !== plugin.id || receipt.verification !== 'native-resume-read-list'
          || receipt.nativeIds.length !== entries.length || new Set(receipt.nativeIds).size !== entries.length
          || entries.some(({ proof }) => !receipt.nativeIds.includes(proof.nativeSource.nativeId))) throw new Error('native import verification failed');
        const keys = new Set<string>();
        const evidence = [];
        for (const { entry, proof } of entries) {
          const snapshot = services.authorization.inspect(proof.context);
          const effective = spacePolicyProfile(profile, state.paths, snapshot.accessCeiling);
          const policy = evaluateRunPolicy({ scope: proof.scope, attachments: [], prompt: '',
            requestedCwd: state.paths.workspace, cwdRealpath: state.paths.workspace,
            profileConfig: effective, capability: plugin.capability(effective), access: { ok: true, reason: 'allowed-team' },
            now: Date.now(), codexHome: effective.codex?.codexHome, inheritCodexHome: effective.codex?.inheritCodexHome });
          if (!policy.ok) throw new Error('imported session no longer satisfies current policy');
          const key = snapshot.executionScope + ':' + policy.policyFingerprint;
          if (keys.has(key)) throw new Error('multiple legacy sessions resolve to the same active space catalog key');
          keys.add(key);
          const recorded = state.sessionCatalog.upsertActive({ scopeId: snapshot.executionScope, agentId: entry.agentId,
            cwdRealpath: state.paths.workspace, policyFingerprint: policy.policyFingerprint, now: entry.updatedAt,
            ...(entry.threadId ? { threadId: entry.threadId } : { sessionId: entry.sessionId! }),
            ...(entry.lastSummary ? { lastSummary: entry.lastSummary } : {}) });
          state.sessions.set(snapshot.executionScope, proof.nativeSource.nativeId, state.paths.workspace);
          const minutes = input.inventory.idleTimeouts[entry.scopeId];
          if (minutes !== undefined) state.sessions.setIdleTimeoutMinutes(snapshot.executionScope, minutes);
          persisted.push({ catalogFile: join(state.paths.control, 'sessions.catalog.json'),
            sessionsFile: join(state.paths.control, 'sessions.json'), key: recorded.key,
            scope: snapshot.executionScope, nativeId: proof.nativeSource.nativeId, cwd: state.paths.workspace });
          importedKeys.push(entry.key);
          sourceChecks.push({ path: proof.nativeSource.sourceFile, sha256: proof.nativeSource.sha256 });
          evidence.push({ sourceKey: entry.key, scopeRef: entry.scopeId, bindingRef: snapshot.binding.ref,
            evidenceDigest: proof.evidenceDigest, sourceDigest: proof.nativeSource.sha256,
            nativeId: proof.nativeSource.nativeId, policyFingerprint: policy.policyFingerprint });
        }
        await writeFileAtomic(join(state.paths.control, 'session-migration.v1.json'),
          JSON.stringify({ schema: 'aria.space.session-migration.v1', engineId: plugin.id, evidence, receipt }) + '\n', { mode: 0o600 });
      }
    } finally { await services.close(); }
    return { importedKeys, sourceChecks, verify: async () => {
      // Imported native IDs were checked before writing resumable catalog state.
      // The management owner additionally hashes the entire staged destination.
      if (new Set(importedKeys).size !== importedKeys.length) throw new Error('duplicate imported ownership');
      for (const expected of persisted) {
        const catalog = await readPrivateJson(expected.catalogFile) as SessionCatalogEntry[];
        const session = (await readPrivateJson(expected.sessionsFile) as Record<string, { sessionId?: string; cwd?: string }>)[expected.scope];
        if (!Array.isArray(catalog) || !catalog.some(entry => entry.key === expected.key
          && entry.status === 'active' && (entry.threadId ?? entry.sessionId) === expected.nativeId)
          || session?.sessionId !== expected.nativeId || session.cwd !== expected.cwd) throw new Error('migrated session state was not durably written');
      }
    } };
  } };
}
