import { prepareEnvironmentPackages, type SpaceEnvironmentPackageDefinition } from './environment-package';
import type { SpaceKey } from './identity';
import type { ExecutionBackend, ExecutionEnvironment } from '../execution/types';
import { opaqueId } from './identity';
import { confinedClaudeHistory } from './claude-history';
import { startSpaceEgress, type ModelEgressRule, type SpaceEgressBroker } from './egress';
import { defineEngineRuntimeDescriptor } from '../agent/runtime/types';
import { bindAgentRun } from '../agent/runtime/bound-run';
import { codexSandboxToAccess, clampAccess } from '../config/permissions';
import type { AgentRunOptions } from '../agent/types';
import { isAbsolute, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { EngineProfileConfig } from '../config/profile-schema';
import { createProfileEngineRuntime } from '../runtime/agent-runtime';
import { ClaudeAdapter } from '../agent/claude/adapter';
import { createAdapterRuntime } from '../agent/runtime/adapter-runtime';
import type { EngineRuntime } from '../agent/runtime/types';
import { registerRuntimeQueries, runtimeQueries } from '../agent/runtime/queries';
import { requireEnginePlugin } from '../agent/plugin/registry';
import { assertConfinedPath, within, prepareSpacePaths, type SpacePaths } from './paths';
import { withConfinedLaunch, type ConfinedLaunch } from './launch';
import { permissionsToLegacySandbox } from '../config/permissions';
import { seedNativeTemplates } from './native-templates';
import { spaceEngineCapabilities } from './capabilities';
import { verifyWorkspaceSkillCatalog } from '../agent/runtime/workspace-assets';

export const SPACE_ENGINE_IDS = ['opencode', 'grok', 'codex', 'claude', 'pi', 'kimi', 'dsh'] as const;
export type SpaceEngineId = typeof SPACE_ENGINE_IDS[number];
export interface SpaceEngineDeployment {
  readonly engineId: SpaceEngineId;
  readonly binary: string;
  readonly binaryVersion: string;
  readonly queryNode?: string;
  readonly tools?: { readonly larkCli: { readonly binary: string; readonly binaryVersion: string; readonly userAuthorization: boolean } };
  readonly environmentPackages?: readonly SpaceEnvironmentPackageDefinition[];
  readonly modelEndpoints?: readonly ModelEgressRule[];
  readonly readonlyResources?: readonly string[];
  readonly templates?: readonly { target: string; contents: string; sha256: string }[];
  readonly launch: Omit<ConfinedLaunch, 'binary' | 'paths' | 'executionEnvironment' | 'driver'> & {
    readonly driver: 'trusted-process' | 'execution';
  };
}

/** Native-specific state projection stays in the engine layer. No host auth import. */
export function spaceEngineProfile(profile: EngineProfileConfig, paths: SpacePaths, deployment: SpaceEngineDeployment): EngineProfileConfig {
  if (profile.agentKind !== deployment.engineId) throw new Error('space engine deployment mismatch');
  if (!deployment.binaryVersion || !isAbsolute(deployment.binary)) throw new Error('space engine requires an explicit verified binary');
  const result = structuredClone(profile);
  result.workspaces = { ...result.workspaces, default: paths.workspace };
  result.sandbox = permissionsToLegacySandbox(result.permissions);
  switch (deployment.engineId) {
    case 'opencode': result.opencode = { ...result.opencode, binaryPath: deployment.binary,
      dataHome: paths.data, configHome: paths.config, cacheHome: paths.cache, stateHome: paths.state }; break;
    case 'grok': result.grok = { ...result.grok, binaryPath: deployment.binary, grokHome: join(paths.home, '.grok'), inheritGrokHome: false }; break;
    case 'codex': result.codex = { ...result.codex, binaryPath: deployment.binary, codexHome: join(paths.home, '.codex'), inheritCodexHome: false }; break;
    case 'pi': result.pi = { ...result.pi, binaryPath: deployment.binary, sessionDir: join(paths.data, 'pi-sessions') }; break;
    case 'kimi': result.kimi = { ...result.kimi, binaryPath: deployment.binary }; break;
    case 'dsh': result.dsh = { ...result.dsh, binaryPath: deployment.binary, dshHome: join(paths.home, '.dsh') }; break;
    case 'claude': break;
  }
  return result;
}

/** Same native protocols as personal mode, under an enforceable launch boundary. */
export async function createSpaceEngineRuntime(input: {
  profile: EngineProfileConfig; paths: SpacePaths; deployment: SpaceEngineDeployment;
  workspaceSkills?: readonly string[]; signal?: AbortSignal;
  spaceKey?: SpaceKey;
  executionBackend?: ExecutionBackend; profileId?: string;
  toolEndpoint?: { source: string; target: string };
}): Promise<EngineRuntime> {
  const { paths, deployment } = input;
  const profile = spaceEngineProfile(input.profile, paths, deployment);
  await prepareSpacePaths(paths);
  if (deployment.templates) await seedNativeTemplates(paths, deployment.templates);
  let broker: SpaceEgressBroker | undefined;
  if (deployment.modelEndpoints?.length) {
    if (!deployment.queryNode) throw new Error('model egress requires an explicitly admitted Node helper');
    broker = await startSpaceEgress({ paths, endpoints: deployment.modelEndpoints });
  }
  const promptDirectory = input.executionBackend ? join(paths.control, 'native-prompts') : paths.control;
  if (input.executionBackend && (deployment.engineId === 'claude' || deployment.engineId === 'kimi')) {
    await mkdir(promptDirectory, { recursive: true, mode: 0o700 });
  }
  let environment: ExecutionEnvironment | undefined;
  try {
    if (input.executionBackend) {
      if (!input.profileId) throw new Error('execution environment requires its profile owner');
      const resources = deployment.readonlyResources ?? [];
      for (const path of resources) {
        await assertConfinedPath('/', path);
        if (within(path, paths.root) || within(paths.root, path)
          || resources.some(other => other !== path && within(other, path))) throw new Error('read-only resource overlaps execution state or another resource');
      }
      environment = await input.executionBackend.open({
        key: opaqueId('space-execution', [input.profileId, paths.spaceId]), revision: deployment.binaryVersion,
        cwd: paths.workspace, workingRoots: [paths.workspace, paths.home, paths.config, paths.data, paths.cache, paths.state],
        mounts: [
          ...resources.map(path => ({ source: path, target: path, writable: false })),
          { source: paths.engine, target: paths.engine, writable: false },
          ...[paths.workspace, paths.home, paths.config, paths.data, paths.cache, paths.state].map(path => ({ source: path, target: path,
            writable: path !== paths.workspace || deployment.launch.workspaceAccess !== 'read-only' })),
          ...(deployment.engineId === 'claude' || deployment.engineId === 'kimi'
            ? [{ source: promptDirectory, target: promptDirectory, writable: false }] : []),
          ...(broker ? [broker.proxyEntry, broker.socket].map(path => ({ source: path, target: path, writable: false })) : []),
          { source: paths.attachments, target: paths.attachments, writable: false },
          ...(input.toolEndpoint ? [{ ...input.toolEndpoint, writable: false }] : []),
        ],
      }, input.signal);
    }
  } catch (error) { await broker?.close(); throw error; }
  const closeEnvironment = async () => { try { await environment?.close(); } finally { await broker?.close(); } };
  let local: Awaited<ReturnType<typeof prepareEnvironmentPackages>> = { environment: {}, instructions: '' };
  try {
    if (deployment.environmentPackages?.length) {
      if (!environment || !input.spaceKey || !input.profileId) throw new Error('environment packages require an acquired Space');
      local = await prepareEnvironmentPackages(deployment.environmentPackages, {
        profileId: input.profileId, key: input.spaceKey, paths, signal: input.signal });
      for (const key of Object.keys(local.environment)) {
        if (key in deployment.launch.environment) throw new Error('package environment conflicts with engine deployment');
      }
    }
  } catch (error) { await closeEnvironment(); throw error; }
  const launch: ConfinedLaunch = Object.freeze({ ...deployment.launch,
    executableRoots: Object.freeze([...deployment.launch.executableRoots]),
    environment: Object.freeze({ ...deployment.launch.environment, ...local.environment }), ...(environment ? { executionEnvironment: environment } : {}), binary: deployment.binary, paths,
    ...(broker ? { proxy: { node: deployment.queryNode!, entry: broker.proxyEntry, socket: broker.socket } } : {}) });
  try {
    await withConfinedLaunch(launch, () => verifyWorkspaceSkillCatalog({ engineId: deployment.engineId, binary: deployment.binary,
      cwd: paths.workspace, home: paths.home, state: paths.state, skills: input.workspaceSkills ?? [], signal: input.signal }));
  } catch (error) { await closeEnvironment(); throw error; }
  // Preserve historical process-driver state layout; container daemons must
  // start within one of the explicitly admitted writable state roots.
  const runtimeStateDirectory = input.executionBackend ? paths.state : paths.engine;
  let engine: EngineRuntime;
  try { engine = deployment.engineId === 'claude' || deployment.engineId === 'kimi'
    ? createAdapterRuntime(new ClaudeAdapter({ binary: deployment.binary, id: deployment.engineId,
      agentId: deployment.engineId, systemPromptDirectory: promptDirectory }))
    : createProfileEngineRuntime(profile, { profileDir: runtimeStateDirectory });
  } catch (error) { await closeEnvironment(); throw error; }
  const ownedQueries = runtimeQueries(engine);
  const legacyPlugin = requireEnginePlugin(deployment.engineId);
  const bound = <T>(operation: () => T): T => withConfinedLaunch(launch, operation);
  const execution = engine.execution;
  const capabilities = spaceEngineCapabilities(deployment.engineId, deployment);
  const forRun = <T>(options: AgentRunOptions, operation: () => T): T => {
    const access = options.sandbox ? codexSandboxToAccess(options.sandbox) : profile.permissions.defaultAccess;
    if (clampAccess(access, launch.workspaceAccess, launch.workspaceAccess) !== access) throw new Error('run exceeds deployment resource ceiling');
    if ((environment || engine.descriptor.topology !== 'one-shot') && access !== launch.workspaceAccess) throw new Error('runtime resource ceiling differs from its fixed space deployment');
    return withConfinedLaunch({ ...launch, workspaceAccess: access }, operation);
  };
  const present = (options: AgentRunOptions): AgentRunOptions => local.instructions
    ? { ...options, prompt: local.instructions + '\n\n' + options.prompt } : options;
  const runtime: EngineRuntime = {
    engineId: engine.engineId, descriptor: defineEngineRuntimeDescriptor({ ...engine.descriptor, capabilities: {
      ...engine.descriptor.capabilities,
      sessions: capabilities.nativeResume ? ['resume', ...(capabilities.nativeHistory ? ['list' as const] : [])] : [],
    } }),
    ...(environment ? { isReusable: () => environment.isUsable?.() !== false } : {}),
    execution: {
      id: execution.id, displayName: execution.displayName,
      isAvailable: () => bound(() => execution.isAvailable()),
      ...(execution.checkAvailability ? { checkAvailability: () => bound(() => execution.checkAvailability!()) } : {}),
      prepareRun: (options) => forRun(options, () => execution.prepareRun?.(present(options)) ?? Promise.resolve()),
      run: (options) => {
        const run = bindAgentRun(forRun(options, () => execution.run(present(options))), (operation) => forRun(options, operation));
        if (!environment) return run;
        return { ...run, stop: async () => {
          // Interrupting an engine protocol is not proof its tool descendants
          // exited. Retire the owned environment before cancellation completes.
          try { await run.stop(); } finally { await environment.close(); }
        } };
      },
    },
    ...(engine.statusSnapshot ? { statusSnapshot: () => bound(() => engine.statusSnapshot!()) } : {}),
    ...(engine.listModels ? { listModels: (signal: AbortSignal) => bound(() => engine.listModels!(signal)) }
      : legacyPlugin.modelLister ? { listModels: (signal: AbortSignal) => bound(() => legacyPlugin.modelLister!({ profileConfig: profile, signal })) } : {}),
    dispose: async () => { try { await bound(() => engine.dispose()); } finally { await closeEnvironment(); } },
  };
  registerRuntimeQueries(runtime, {
    ...(ownedQueries.listHistory ? { listHistory: (query) => bound(() => ownedQueries.listHistory!(query)) }
      : deployment.engineId === 'opencode' && legacyPlugin.listHistory ? {
        listHistory: (query) => bound(() => legacyPlugin.listHistory!({ ...query, profileConfig: profile, profileDir: runtimeStateDirectory })),
      } : deployment.engineId === 'claude' && deployment.queryNode ? {
        listHistory: async (query) => confinedClaudeHistory(launch, deployment.queryNode!, query.cwd, query.limit),
      } : {}),
  });
  return runtime;
}
