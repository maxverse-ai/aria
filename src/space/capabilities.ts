import type { SpaceEngineDeployment, SpaceEngineId } from './engine-runtime';
import type { EngineProfileConfig } from '../config/profile-schema';

export function executionSpaceMode(profile: Pick<EngineProfileConfig, 'mode' | 'executionSpaces'>): 'personal' | 'legacy-team' | 'team' {
  return profile.executionSpaces ? 'team' : profile.mode === 'team' ? 'legacy-team' : 'personal';
}
/** These are implementation capabilities, not a claim of native/provider
 * acceptance on every deployment. Readiness probes the selected exact binary. */
export function spaceEngineCapabilities(engineId: SpaceEngineId, deployment: Pick<SpaceEngineDeployment, 'queryNode' | 'tools'> = {}) {
  return {
    engineId,
    topology: ['codex', 'grok', 'devin'].includes(engineId) ? 'profile-daemon' as const : 'one-shot' as const,
    nativeResume: engineId !== 'dsh',
    nativeHistory: ['codex', 'grok', 'opencode', 'mimo', 'devin'].includes(engineId) || (engineId === 'claude' && Boolean(deployment.queryNode)),
    catalogHistory: true,
    verifiedNativeImport: engineId === 'codex',
    nativeTools: deployment.tools ? ['lark-cli'] : [],
    userToolAuthorization: deployment.tools?.larkCli.userAuthorization === true,
    realProviderAcceptance: 'deployment-evidence-required',
  };
}
