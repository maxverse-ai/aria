import { ChannelPluginError } from '../plugin/errors';

export const WECHAT_KF_CHANNEL_ROLLOUT_ENV = 'ARIA_WECHAT_KF_CHANNEL_ROLLOUT' as const;
export const CURRENT_DEFAULT_WECHAT_KF_CHANNEL_ROLLOUT_MODE = 'shadow' as const;

export type WechatKfChannelRolloutMode = 'off' | 'shadow' | 'opt-in' | 'default-on';

export interface WechatKfChannelOwnershipPolicy {
  mode: WechatKfChannelRolloutMode;
  owner: 'legacy' | 'manager';
  managerEnabled: boolean;
}

const MODES = new Set<WechatKfChannelRolloutMode>([
  'off',
  'shadow',
  'opt-in',
  'default-on',
]);

/** Temporary, bounded ownership switch for the existing Customer Service entry. */
export function resolveWechatKfChannelOwnership(
  rawMode: string | undefined,
  defaultMode: WechatKfChannelRolloutMode = CURRENT_DEFAULT_WECHAT_KF_CHANNEL_ROLLOUT_MODE,
): Readonly<WechatKfChannelOwnershipPolicy> {
  const mode = rawMode === undefined || rawMode.trim() === '' ? defaultMode : rawMode.trim();
  if (!MODES.has(mode as WechatKfChannelRolloutMode)) {
    throw new ChannelPluginError('invalid wxkf channel rollout mode', {
      kind: 'configuration',
      code: 'invalid-wechat-kf-channel-rollout-mode',
    });
  }
  const resolved = mode as WechatKfChannelRolloutMode;
  return Object.freeze({
    mode: resolved,
    owner: resolved === 'opt-in' || resolved === 'default-on' ? 'manager' : 'legacy',
    managerEnabled: resolved !== 'off',
  });
}
