import type { PreparedSpaceProfile } from '../space/profile';
import type { LarkChannel } from '@larksuite/channel';
import { LarkSpaceIdentity } from './lark-space-identity';
import { canUseDm, canUseGroup } from '../policy/access';
import type { Controls } from '../commands';
import { SpaceOperationGate } from '../space/operation-gate';
import { clampAccess, permissionsToLegacySandbox } from '../config/permissions';
import { LarkSpaceCredentialProvider } from '../lark-cli/space-credentials';
import { larkSpaceNativeTool } from '../lark-cli/space-tool';
import { runtimeQueries, type EngineGoalSetInput } from '../agent/runtime/queries';
import type { AppPaths } from '../config/app-paths';
import { join } from 'node:path';

/** Each request gets its own view; no mutable profile-wide "current user". */
export async function spaceChannelContext(controls: Controls, gate: SpaceOperationGate) {
  const operation = gate.active();
  const snapshot = gate.services.authorization.inspect(operation.context);
  const state = await gate.services.state.view(operation.context);
  const access = clampAccess(controls.profileConfig.permissions.defaultAccess,
    controls.profileConfig.permissions.maxAccess, snapshot.accessCeiling);
  const profileConfig = { ...controls.profileConfig,
    permissions: { ...controls.profileConfig.permissions, defaultAccess: access, maxAccess: access },
    sandbox: permissionsToLegacySandbox({ defaultAccess: access, maxAccess: access }),
    workspaces: { ...controls.profileConfig.workspaces, default: state.paths.workspace } };
  const scopedControls: Controls = { ...controls, profileConfig, spaceGate: gate,
    engineStatus: () => gate.services.query(operation.context, async (runtime) => runtime.statusSnapshot?.()),
    engineModels: (signal) => gate.services.query(operation.context, async (runtime) => runtime.listModels?.(signal) ?? []),
    engineGoal: {
      get: (threadId: string) => gate.services.query(operation.context, async (runtime) => {
        const goal = runtimeQueries(runtime).goal;
        if (!goal) throw new Error('this engine runtime does not carry goals');
        return goal.get(threadId);
      }),
      set: (threadId: string, input: EngineGoalSetInput) => gate.services.query(operation.context, async (runtime) => {
        const goal = runtimeQueries(runtime).goal;
        if (!goal) throw new Error('this engine runtime does not carry goals');
        return goal.set(threadId, input);
      }),
      clear: (threadId: string) => gate.services.query(operation.context, async (runtime) => {
        const goal = runtimeQueries(runtime).goal;
        if (!goal) throw new Error('this engine runtime does not carry goals');
        return goal.clear(threadId);
      }),
    },
    engineHistory: (cwd, limit) => gate.services.history(operation.context, cwd, limit),
    // Cache partitions include the space, never a profile-global account result.
    engineGeneration: () => Number.parseInt(snapshot.binding.spaceId.slice(0, 12), 16),
  };
  return { operation, controls: scopedControls, ...state };
}

export async function createLarkSpaceGate(profile: PreparedSpaceProfile, channel: LarkChannel, instanceId: string, controls: Controls, appPaths?: AppPaths): Promise<SpaceOperationGate> {
  const identity = new LarkSpaceIdentity({ authorization: profile.services.authorization, channel,
    appId: controls.cfg.accounts.app.id, instanceId });
  const gate = new SpaceOperationGate(profile.services, identity, profile.grants, (request) => ({
    admitted: (request.kind === 'direct' ? canUseDm(controls.profileConfig, controls, request.senderId)
      : canUseGroup(controls.profileConfig, controls, request.conversationId, request.senderId)).ok,
    accessCeiling: controls.profileConfig.permissions.maxAccess,
  }), Date.now, profile.resources);
  await profile.registerGate({ pluginId: 'lark', instanceId, authorityId: identity.authorityId }, gate);
  const deployment = profile.toolDeployment?.larkCli;
  if (deployment && !profile.tools.has('lark', identity.authorityId)) {
    if (!appPaths || !profile.nativeTools) throw new Error('native Lark tools require their host profile paths');
    profile.tools.register(new LarkSpaceCredentialProvider({ authorityId: identity.authorityId,
      directory: join(profile.stateDirectory, 'space-control', 'tool-credentials'), stateDirectory: profile.stateDirectory,
      binary: deployment.binary, source: { config: controls.cfg, paths: appPaths } }));
    profile.nativeTools.register(larkSpaceNativeTool({ authorityId: identity.authorityId, credentials: profile.tools,
      userAuthorization: deployment.userAuthorization }));
  }
  return gate;
}
