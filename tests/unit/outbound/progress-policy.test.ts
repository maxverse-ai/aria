import { expect, it, vi } from 'vitest';
import { checkProgress, type ProgressPolicy, type ProgressPolicyInput } from '../../../src/outbound/progress-policy';

it('lets policy finish an owned terminal after CoT is disabled, without authorizing new content', async () => {
  const check = vi.fn(async (input: Readonly<ProgressPolicyInput>) => {
    if (input.content !== '{"reason":"interrupted"}') throw new Error('terminal payload denied');
  });
  const policy: ProgressPolicy = { apiVersion: 1, formats: ['card'], check };
  const input = { format: 'cot' as const, phase: 'complete' as const, content: '{"reason":"interrupted"}',
    context: { source: 'system' as const, senderOpenId: 'host-cleanup', sourceMessageId: 'owned', conversationId: 'cleanup', runId: 'owned' } };
  await checkProgress(policy, true, input);
  expect(check).toHaveBeenCalledOnce();
  await expect(checkProgress(policy, true, { ...input, phase: 'update' })).rejects.toThrow('unavailable');
  await expect(checkProgress(policy, true, { ...input, content: '{"private":"old content"}' })).rejects.toThrow('denied');
  await expect(checkProgress(undefined, true, input)).rejects.toThrow('does not support');
});
