import type { ExecutionBackend } from '../execution/types';
import { SpaceNativeRead } from './native-read';
import { SpaceReadAccess } from './read-access';
import { join } from 'node:path';
import type { EngineProfileConfig } from '../config/profile-schema';
import { SpaceBindingStore } from './bindings';
import { SpaceAuthorization } from './authorization';
import { SpaceStateStore } from './state';
import { SpaceRuntimeRegistry } from './runtime-registry';
import { ExecutionSpaceServices } from './services';
import { ExecutionGrantStore, SpaceToolIdentity } from './grants';
import { SpaceToolCredentials } from './tool-credentials';
import { SpaceNativeTools } from './native-tools';
import { SpaceResourceStore } from './resources';
import { SpaceOperationGate } from './operation-gate';
import { SpaceOperationLedger } from './operation-ledger';
import { SpaceTriggerBoundary } from './trigger-boundary';
import { createSpaceEngineRuntime, type SpaceEngineDeployment } from './engine-runtime';
import { resolveSpacePaths } from './paths';
import { opaqueId } from './identity';
import type { TriggerDefinition } from '../trigger/state';
import type { RunIntent } from '../application/execution-intent';
import type { ChannelOutboundIntent } from '../channel/plugin/types';
import { SpaceWorkspaces } from './workspace';
import { EMPTY_SPACE_WORKSPACES, type SpaceWorkspacesDefinition } from './workspace-definition';
import { deployedToolRevisions } from './deployment';
import { loadSpaceToolExtension, type SpaceToolExtensionDefinition } from './tool-extension';
import { selectWorkspaceLayers } from './workspace-definition';

/** Internal composition receipt. No stored mode flag or OAuth can construct it. */
export class PreparedSpaceProfile {
  readonly reads: SpaceNativeRead;
  readonly readAccess: SpaceReadAccess;
  readonly tools: SpaceToolCredentials;
  readonly nativeTools?: SpaceNativeTools;
  workspaces!: SpaceWorkspaces;
  private readonly boundaries = new Map<string, SpaceTriggerBoundary>();
  private extensions: readonly SpaceToolExtensionDefinition[] = [];
  private workspaceDefinition: SpaceWorkspacesDefinition = EMPTY_SPACE_WORKSPACES;
  private constructor(readonly services: ExecutionSpaceServices, readonly grants: ExecutionGrantStore,
    readonly resources: SpaceResourceStore, private readonly directory: string, readonly toolDeployment?: SpaceEngineDeployment['tools'], node?: string, containerTransport = false, workspaceTransport = false) {
    this.reads = new SpaceNativeRead(services);
    this.readAccess = new SpaceReadAccess({ services, reads: this.reads,
      file: join(directory, 'space-control', 'read-access.v1.json'), gate: id => this.sourceGate(id) });
    this.tools = new SpaceToolCredentials(services.authorization, new SpaceToolIdentity(services.authorization,
      Date.now, join(directory, 'space-control', 'tool-identity.v1.json')));
    if (toolDeployment || workspaceTransport) {
      if (!node) throw new Error('native tools require a declared Node helper');
      this.nativeTools = new SpaceNativeTools({ authorization: services.authorization, directory, node, containerTransport, activeGate: () => this.activeGate() });
      services.installTools(this.nativeTools);
    }
  }
  get stateDirectory(): string { return this.directory; }
  static async create(input: { profileId: string; profile: EngineProfileConfig; directory: string; deployment: SpaceEngineDeployment; executionBackend?: ExecutionBackend; workspaces?: SpaceWorkspacesDefinition }): Promise<PreparedSpaceProfile> {
    if (input.profile.mode !== 'team') throw new Error('prepared spaces require explicit team intent');
    const bindings = new SpaceBindingStore(join(input.directory, 'space-control', 'bindings.v1.json'));
    await bindings.load();
    const authorization = new SpaceAuthorization(input.profileId, bindings);
    const grants = new ExecutionGrantStore(authorization, join(input.directory, 'space-control', 'execution-grants.v1.json'));
    const resources = new SpaceResourceStore(authorization, join(input.directory, 'space-control', 'resources.v1.json'));
    await Promise.all([grants.load(), resources.load()]);
    const profile = structuredClone(input.profile);
    const deployment = structuredClone(input.deployment);
    const workspaces = new SpaceWorkspaces({ profileId: input.profileId, directory: input.directory, authorization,
      engineId: deployment.engineId, driver: deployment.launch.driver, definition: input.workspaces ?? EMPTY_SPACE_WORKSPACES,
      readonlyResources: deployment.readonlyResources, availableTools: deployedToolRevisions(deployment.tools, input.workspaces?.extensions) });
    if (input.workspaces?.extensions?.length && (!['trusted-process', 'execution'].includes(deployment.launch.driver ?? '') || !deployment.queryNode)) {
      throw new Error('workspace tools require a prepared native tool transport');
    }
    const runtimes = new SpaceRuntimeRegistry({ authorization, ...(input.workspaces ? { workspaces } : {}),
      topology: ['codex', 'grok'].includes(deployment.engineId) ? 'profile-daemon' : 'one-shot',
      create: async (context, signal) => {
        const runtime = await createSpaceEngineRuntime({ profile, deployment, signal, executionBackend: input.executionBackend, profileId: input.profileId,
          spaceKey: context.binding.key,
          ...(input.executionBackend && prepared.nativeTools ? { toolEndpoint: await prepared.nativeTools.endpoint(context.binding.key) } : {}), workspaceSkills: workspaces.skills(context.binding.key),
          paths: resolveSpacePaths(input.directory, context.binding.key) });
        try { await workspaces.recordDiscovery(context.binding.key); return runtime; }
        catch (error) { await runtime.dispose(); throw error; }
      } });
    const prepared = new PreparedSpaceProfile(new ExecutionSpaceServices(authorization, new SpaceStateStore(input.directory, authorization), runtimes),
      grants, resources, input.directory, deployment.tools, deployment.queryNode, Boolean(input.executionBackend), Boolean(input.workspaces?.extensions?.length));
    prepared.workspaces = workspaces;
    prepared.extensions = structuredClone(input.workspaces?.extensions ?? []);
    prepared.workspaceDefinition = structuredClone(input.workspaces ?? EMPTY_SPACE_WORKSPACES);
    try {
      await Promise.all([prepared.readAccess.load(), prepared.tools.identity.load()]);
      return prepared;
    } catch (error) { await prepared.services.close(); throw error; }
  }
  async registerGate(source: { pluginId: string; instanceId: string; authorityId?: string }, gate: SpaceOperationGate): Promise<void> {
    const { instanceId } = source;
    if (gate.services !== this.services) throw new Error('source must share its profile execution authority');
    const ledger = new SpaceOperationLedger(gate, join(this.directory, 'space-control', opaqueId('source-ledger', [instanceId]) + '.json'));
    await ledger.load();
    this.boundaries.set(instanceId, new SpaceTriggerBoundary(ledger, Object.freeze({ ...source })));
    const authorityId = source.authorityId;
    for (const definition of this.extensions) {
      if (!this.nativeTools || !authorityId || !/^[a-f0-9]{64}$/.test(authorityId)) throw new Error('native tool extension requires its host owner and source authority');
      if (this.nativeTools.has(definition.id, authorityId)) continue;
      const tool = await loadSpaceToolExtension(definition, { authorityId, profileId: this.services.authorization.profileId,
        directory: this.directory, credentials: this.tools, activeGate: () => this.activeGate() });
      try { this.nativeTools.register({ id: tool.id, authorityId: tool.authorityId, description: tool.description,
        invoke: (operation, request) => tool.invoke(operation, request),
        activeWork: () => tool.activeWork?.() ?? 0, close: async () => { await tool.close?.(); },
        available: snapshot => selectWorkspaceLayers(this.workspaceDefinition, snapshot.binding.key)
        .bundles.some(b => b.requiresTools?.some(t => t.id === definition.id && t.revision === definition.revision)) }); }
      catch (error) { await tool.close?.(); throw error; }
    }
  }
  sourceGate(instanceId: string): SpaceOperationGate {
    const boundary = this.boundaries.get(instanceId);
    if (!boundary) throw new Error('original source is unavailable');
    return boundary.ledger.gate;
  }
  activeGate(): SpaceOperationGate {
    const matches = [...this.boundaries.values()].filter(boundary => {
      try { boundary.ledger.gate.active(); return true; } catch { return false; }
    });
    if (matches.length !== 1) throw new Error('native projection requires its authenticated source operation');
    return matches[0]!.ledger.gate;
  }
  async bindDefinition(definition: TriggerDefinition): Promise<void> {
    for (const boundary of this.boundaries.values()) {
      let operation;
      try { operation = boundary.ledger.gate.active(); } catch { continue; }
      await boundary.bindDefinition(definition, operation); return;
    }
    throw new Error('team trigger creation requires an authenticated original source operation');
  }
  private definitionBoundary(id: string, revision: string | number | undefined): SpaceTriggerBoundary {
    const key = 'definition:' + id + ':' + revision;
    const matches = [...this.boundaries.values()].filter((boundary) => boundary.ledger.has(key));
    if (matches.length !== 1) throw new Error('original trigger source is unavailable');
    return matches[0]!;
  }
  async authorizeIntent(intent: RunIntent) {
    const boundary = this.definitionBoundary(intent.correlation.attributes?.triggerDefinitionId ?? '', intent.correlation.attributes?.triggerDefinitionRevision);
    return { boundary, operation: await boundary.authorizeIntent(intent) };
  }
  bindResult(definition: TriggerDefinition, intent: ChannelOutboundIntent): Promise<void> {
    return this.definitionBoundary(definition.id, definition.revision).bindResult(definition, intent);
  }
  deliver<T>(intent: ChannelOutboundIntent, send: () => Promise<T>): Promise<T> {
    const matches = [...this.boundaries.values()].filter((b) => b.ledger.has('delivery:' + intent.deliveryId));
    if (matches.length !== 1) throw new Error('result has no unique original space owner');
    return matches[0]!.deliver(intent, send);
  }
}
