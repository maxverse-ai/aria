import {
  accessToClaudePermissionMode,
  accessToCodexSandbox,
  type PermissionConfig,
} from '../config/permissions';
import type { EffectivePolicy } from '../policy/effective-policy';

/**
 * v1 compatibility projection. Keep these bytes stable for existing sessions
 * and adapters; new engine contracts consume the effective resource ceiling.
 */
export function legacyEnginePermissions(
  policy: EffectivePolicy,
  config: PermissionConfig,
) {
  return {
    sandbox: accessToCodexSandbox(policy.accessMode),
    permissionMode: accessToClaudePermissionMode(policy.accessMode, config),
  };
}
