import { mergeProcessEnv } from '../platform/spawn';
import { OUTBOUND_POLICY_MODULE_ENV } from '../outbound/plugin';

const AGENT_BOUND_ENV_KEYS = new Set([
  'LARK_CHANNEL',
  'LARK_CHANNEL_HOME',
  'LARK_CHANNEL_PROFILE',
  'LARK_CHANNEL_CONFIG',
  'LARKSUITE_CLI_CONFIG_DIR',
]);

/**
 * Build the child environment. Normal Aria runs preserve today's inheritance;
 * a configured outbound policy activates the hardened boundary and exposes
 * only the five bridge-bound locator variables to the agent process.
 */
export function buildAgentLaunchEnv(
  overrides: NodeJS.ProcessEnv = {},
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const merged = mergeProcessEnv(base, overrides);
  if (!base[OUTBOUND_POLICY_MODULE_ENV]?.trim()) return merged;

  for (const key of Object.keys(merged)) {
    if (isBridgeOnlyEnvKey(key)) delete merged[key];
  }
  return merged;
}

function isBridgeOnlyEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  if (AGENT_BOUND_ENV_KEYS.has(normalized)) return false;
  return normalized.startsWith('LARK_')
    || normalized.startsWith('LARKSUITE_')
    || normalized.startsWith('FEISHU_')
    || /^(?:BRIDGE|SEND)(?:_|$)/.test(normalized)
    || /^ARIA_.*(?:FEISHU|LARK|BRIDGE|SEND)(?:_|$)/.test(normalized)
    || /(?:FEISHU|LARK|BRIDGE|SEND).*(?:TOKEN|SECRET|KEY|AUTH|CREDENTIAL|PASSWORD)/.test(
      normalized,
    );
}
