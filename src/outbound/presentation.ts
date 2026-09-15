import { getCotMessages, getMessageReplyMode, getShowToolCalls, type AppConfig,
  type CotMessagesMode, type MessageReplyMode } from '../config/schema';
import type { ProgressFormat } from './progress-policy';

export interface PresentationState {
  schema: 'aria.presentation.v1';
  configured: { cotMessages: CotMessagesMode; messageReply: MessageReplyMode; showToolCalls: boolean };
  effective: { cotMessages: CotMessagesMode; messageReply: MessageReplyMode;
    progress: 'cot' | 'updates' | 'none'; showToolCalls: boolean };
  reasons: readonly ('policy-progress-unavailable' | 'final-only-policy')[];
}

/** One resolver for execution, status cards and authenticated management reads.
 * Space identity does not own presentation preferences. */
export function resolvePresentation(config: AppConfig, input: {
  spaces: boolean; policy: boolean; checkedFormats?: readonly ProgressFormat[];
}): PresentationState {
  const configured = { cotMessages: getCotMessages(config), messageReply: getMessageReplyMode(config),
    showToolCalls: getShowToolCalls(config) };
  // Preserve the legacy direct CoT route for old personal/legacy-team plugins.
  // Prepared spaces require explicit policy support for the bound route.
  const cotAllowed = !input.spaces || !input.policy || Boolean(input.checkedFormats?.includes('cot'));
  const cotMessages = cotAllowed ? configured.cotMessages : 'off';
  const updatesAllowed = !input.policy || (input.spaces && Boolean(input.checkedFormats?.includes('card')));
  const progress = cotMessages !== 'off' ? 'cot'
    : configured.messageReply !== 'text' && updatesAllowed ? 'updates' : 'none';
  const reasons: PresentationState['reasons'][number][] = [];
  if (!cotAllowed && configured.cotMessages !== 'off') reasons.push('policy-progress-unavailable');
  if (progress === 'none' && configured.messageReply !== 'text' && !updatesAllowed) reasons.push('final-only-policy');
  return { schema: 'aria.presentation.v1', configured,
    effective: { cotMessages, messageReply: configured.messageReply, progress,
      showToolCalls: configured.showToolCalls && progress !== 'none' }, reasons };
}

export function presentationDescription(state: PresentationState): string {
  const detail = state.effective.cotMessages === 'detailed' ? '详细' : '简略';
  const result = state.effective.progress === 'cot' ? `过程消息：${detail}，已生效`
    : state.effective.progress === 'updates' ? '过程消息：卡片更新，已生效' : '过程消息：仅最终回复';
  return state.reasons.length ? `${result}（当前部署策略尚未支持所选过程展示）` : result;
}

/** The management boundary exports only this public allowlist, even when a
 * future runtime adds private diagnostic fields to its local snapshot. */
export function publicPresentation(value: unknown): PresentationState | undefined {
  const state = value as PresentationState | undefined;
  const valid = (settings: PresentationState['configured'] | undefined): settings is PresentationState['configured'] =>
    Boolean(settings && ['off', 'brief', 'detailed'].includes(settings.cotMessages)
      && ['text', 'markdown', 'card'].includes(settings.messageReply) && typeof settings.showToolCalls === 'boolean');
  if (state?.schema !== 'aria.presentation.v1' || !valid(state.configured) || !valid(state.effective)
    || !['cot', 'updates', 'none'].includes(state.effective.progress) || !Array.isArray(state.reasons)
    || state.reasons.some(reason => !['policy-progress-unavailable', 'final-only-policy'].includes(reason))) return;
  const settings = (input: PresentationState['configured']) => ({ cotMessages: input.cotMessages,
    messageReply: input.messageReply, showToolCalls: input.showToolCalls });
  return { schema: 'aria.presentation.v1', configured: settings(state.configured),
    effective: { ...settings(state.effective), progress: state.effective.progress }, reasons: [...state.reasons] };
}
