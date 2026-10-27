import { AsyncLocalStorage } from 'node:async_hooks';
import { composeSystemPrompt, type SystemPromptParts } from './system-prompt';

const prompts = new AsyncLocalStorage<SystemPromptParts>();
export function activePresentationParts(): SystemPromptParts | undefined { return prompts.getStore(); }
export function activeSystemPrompt(): string | undefined {
  const parts = activePresentationParts();
  return parts ? composeSystemPrompt(parts) : undefined;
}
/** Trusted ingress supplies channel instructions; observability never selects them. */
export function withRunPresentation<T>(channelPrompt: string | undefined, isolated: boolean, operation: () => T, tools?: string): T {
  return prompts.run({
    source: channelPrompt ?? '',
    tools: isolated
      ? ['本次任务使用独立工作目录和受控工具。仅使用当前环境明确提供的工具与凭证；没有授权的服务应报告不可用。', tools].filter(Boolean).join('\n')
      : undefined,
  }, operation);
}
