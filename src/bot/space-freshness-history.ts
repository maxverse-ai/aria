import type { SpaceOperationGate } from '../space/operation-gate';
import { fetchFreshnessHistory, type FreshnessHistoryResult } from './freshness-history';

/** Host-only history adapter: exact audience, fresh authority, per-sender admission. */
export async function fetchSpaceFreshnessHistory(
  gate: SpaceOperationGate,
  input: Parameters<typeof fetchFreshnessHistory>[0],
  fetchHistory = fetchFreshnessHistory,
): Promise<FreshnessHistoryResult> {
  const original = gate.active();
  const scopeRef = input.threadId ? `${input.chatId}:${input.threadId}` : input.chatId;
  if (original.request.conversationId !== input.chatId || original.scopeRef !== scopeRef ||
    (original.request.kind === 'direct') !== (input.chatType === 'p2p')) {
    throw new Error('history audience differs from the active space operation');
  }
  await gate.refresh(original);
  const history = await fetchHistory(input);
  await gate.refresh(original);
  const admitted: FreshnessHistoryResult['inputs'] = [];
  for (const entry of history.inputs) {
    if (!entry.senderType) continue;
    let operation;
    try {
      operation = await gate.admitHistory(original, { conversationId: input.chatId, senderId: entry.message.senderId,
        senderKind: entry.senderType === 'bot' ? 'agent' : 'user',
        kind: input.chatType === 'p2p' ? 'direct' : 'group' });
    } catch { continue; } // A history item never grants the sender access.
    if (operation.bindingRef !== original.bindingRef || operation.executionScope !== original.executionScope) continue;
    await gate.resources.record(operation.context, 'message', entry.message.messageId);
    admitted.push({ ...entry, spaceOperation: operation });
  }
  await gate.refresh(original);
  return { ...history, inputs: admitted };
}
