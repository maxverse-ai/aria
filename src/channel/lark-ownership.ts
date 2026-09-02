import { ChannelPluginError } from './plugin/errors';

export const LARK_CHANNEL_ROLLOUT_ENV = 'ARIA_LARK_CHANNEL_ROLLOUT' as const;
export const CURRENT_DEFAULT_LARK_CHANNEL_ROLLOUT_MODE = 'shadow' as const;

export type LarkChannelRolloutMode =
  | 'off'
  | 'shadow'
  | 'opt-in'
  | 'default-on';

export interface LarkChannelOwnershipPolicy {
  mode: LarkChannelRolloutMode;
  owner: 'legacy' | 'manager';
  managerEnabled: boolean;
}

const ROLLOUT_MODES = new Set<LarkChannelRolloutMode>([
  'off',
  'shadow',
  'opt-in',
  'default-on',
]);

/**
 * Resolve the temporary Lark lifecycle migration control.
 *
 * `off` is the hard rollback path, `shadow` observes an empty manager while
 * the legacy bridge remains authoritative, and the two enabled rollout modes
 * make ChannelManager the sole transport owner. The current default remains
 * `shadow`; a later reviewed stage can change only the default constant after
 * opt-in evidence exists.
 */
export function resolveLarkChannelOwnership(
  rawMode: string | undefined,
  defaultMode: LarkChannelRolloutMode = CURRENT_DEFAULT_LARK_CHANNEL_ROLLOUT_MODE,
): Readonly<LarkChannelOwnershipPolicy> {
  const mode = rawMode === undefined || rawMode.trim() === ''
    ? defaultMode
    : rawMode.trim();
  if (!ROLLOUT_MODES.has(mode as LarkChannelRolloutMode)) {
    throw new ChannelPluginError('invalid Lark channel rollout mode', {
      kind: 'configuration',
      code: 'invalid-lark-channel-rollout-mode',
    });
  }

  const resolved = mode as LarkChannelRolloutMode;
  return Object.freeze({
    mode: resolved,
    owner: resolved === 'opt-in' || resolved === 'default-on' ? 'manager' : 'legacy',
    managerEnabled: resolved !== 'off',
  });
}
