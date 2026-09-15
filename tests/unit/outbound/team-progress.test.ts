import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateFixture } from '../../helpers/space-gate';
import { BoundCotClient, completeInterrupted } from '../../../src/outbound/bound-cot';
import { resolvePresentation, publicPresentation } from '../../../src/outbound/presentation';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema';
import type { ProgressReceipt } from '../../../src/space/resources';
import { ProgressCard } from '../../../src/outbound/progress-card';
import { interruptedProgressCard } from '../../../src/card/progress-card';
import { spaceLarkChannel } from '../../../src/outbound/space-lark-channel';
import { createFakeChannel } from '../../helpers/fake-channel';
import type { LarkChannel } from '@larksuite/channel';

const cleanup: Array<() => Promise<unknown>> = [];
const profile = () => createDefaultProfileConfig({ agentKind: 'claude',
  accounts: { app: { id: 'fixture', secret: 'fixture', tenant: 'feishu' } } });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(persistent = false) {
  const root = await mkdtemp(join(tmpdir(), 'aria-progress-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const f = await gateFixture(root, { persistent }); cleanup.push(() => f.services.close());
  const request = { conversationId: 'group-a', senderId: 'a', senderKind: 'user' as const, kind: 'group' as const };
  const operation = await f.gate.enter(request, 'group-a');
  await f.resources.record(operation.context, 'message', 'origin');
  const client = { create: vi.fn(async () => ({ cot_id: 'cot', message_id: 'bubble' })),
    update: vi.fn(async () => {}), complete: vi.fn(async () => {}) };
  const context = { source: 'im' as const, conversationId: 'group-a', senderOpenId: 'a', sourceMessageId: 'origin', runId: 'run' };
  const bound = new BoundCotClient({ client, gate: f.gate, operation, context, policyRequired: false });
  return { ...f, root, operation, client, context, bound };
}

describe('Team presentation compatibility', () => {
  it.each(['off', 'brief', 'detailed'] as const)('retains configured %s for the checked Team transport', mode => {
    const config = profile(); config.preferences = { cotMessages: mode, messageReply: 'markdown', showToolCalls: true };
    const state = resolvePresentation(config, { spaces: true, policy: true, checkedFormats: ['cot', 'card'] });
    expect(state.configured.cotMessages).toBe(mode); expect(state.effective.cotMessages).toBe(mode);
    expect(state.effective.progress).toBe(mode === 'off' ? 'updates' : 'cot'); expect(state.reasons).toEqual([]);
  });
  it('reports a legacy policy restriction instead of pretending detailed is active', () => {
    const config = profile();
    const state = resolvePresentation(config, { spaces: true, policy: true });
    expect(state.configured.cotMessages).toBe('detailed'); expect(state.effective.cotMessages).toBe('off');
    expect(state.effective.progress).toBe('none'); expect(state.reasons).toContain('policy-progress-unavailable');
    expect(resolvePresentation(config, { spaces: false, policy: true }).effective.cotMessages).toBe('detailed');
  });
  it('re-reads profile preferences and allowlists runtime diagnostics', () => {
    const config = profile();
    config.preferences.cotMessages = 'brief';
    const state = resolvePresentation(config, { spaces: true, policy: false });
    expect(state.effective.cotMessages).toBe('brief');
    expect(publicPresentation({ ...state, privateData: 'secret', effective: { ...state.effective, secret: 'secret' } })).toEqual(state);
    expect(publicPresentation({ ...state, reasons: ['secret'] })).toBeUndefined();
    config.preferences.cotMessages = 'off';
    expect(resolvePresentation(config, { spaces: false, policy: true, checkedFormats: ['card'] }).effective.progress).toBe('none');
  });
});

it('coalesces card snapshots, flushes the terminal frame and drops all timers on close', async () => {
  const f = await fixture(); const fake = createFakeChannel();
  const card = new ProgressCard({ channel: spaceLarkChannel(fake as unknown as LarkChannel, f.gate), gate: f.gate,
    operation: f.operation, context: f.context, policyRequired: false, sendOptions: { replyTo: 'origin' }, terminate: vi.fn() });
  await card.update({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'started' }] } });
  vi.useFakeTimers();
  try {
    for (let i = 0; i < 200; i++) card.queue({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: `progress ${i}` }] } });
    card.queue({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'finished' }] } });
    expect(fake.sent).toHaveLength(1);
    const receipt = await card.finish();
    expect(receipt?.messageId).toBeDefined();
    expect(fake.sent).toHaveLength(1);
    expect(JSON.stringify(fake.rawClient.requests)).toContain('finished');
    expect(JSON.stringify(fake.rawClient.requests)).not.toContain('progress 199');
    await card.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
    expect(fake.sent).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it('drops a queued card when the run closes before the transport starts', async () => {
  const f = await fixture(); const fake = createFakeChannel();
  const card = new ProgressCard({ channel: spaceLarkChannel(fake as unknown as LarkChannel, f.gate), gate: f.gate,
    operation: f.operation, context: f.context, policyRequired: false, sendOptions: { replyTo: 'origin' }, terminate: vi.fn() });
  card.queue({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'private pending' }] } });
  await card.close(); await card.finish();
  expect(fake.sent).toHaveLength(0); expect(fake.rawClient.requests).toHaveLength(0);
});

describe('bound CoT lifecycle', () => {
  it('sends owned detail and completes once with no remaining recovery work', async () => {
    const f = await fixture(); const ref = { cotId: 'cot', messageId: 'bubble' };
    await f.bound.create('group-a', 'origin');
    await f.bound.update(ref, [{ event_type: 'TOOL_CALL_RESULT', content: 'tool detail', timestamp: 1 }]);
    await f.bound.complete(ref, 'success'); await f.bound.close();
    expect(f.client.update).toHaveBeenCalledOnce(); expect(f.client.complete).toHaveBeenCalledOnce();
    expect(f.resources.pendingProgress(f.source.authorityId, 'primary')).toEqual([]);
  });
  it('drops late private detail after a member joins and only closes the existing bubble', async () => {
    const f = await fixture(); const ref = { cotId: 'cot', messageId: 'bubble' };
    await f.bound.create('group-a', 'origin'); f.state.humans = ['a', 'b'];
    await expect(f.bound.update(ref, [{ event_type: 'TOOL_CALL_RESULT', content: 'private detail', timestamp: 1 }])).rejects.toThrow();
    await f.bound.close();
    expect(f.client.update).not.toHaveBeenCalled(); expect(f.client.complete).toHaveBeenCalledWith(ref, 'interrupted');
    f.state.humans = ['a'];
    await expect(f.bound.update(ref, [])).rejects.toThrow();
  });
  it('rechecks after slow policy inspection and does not create a bubble in the new audience', async () => {
    const f = await fixture();
    const bound = new BoundCotClient({ client: f.client, gate: f.gate, operation: f.operation, context: f.context,
      policyRequired: true, policy: { apiVersion: 1, formats: ['cot'], check: async () => { f.state.humans = ['a', 'b']; } } });
    await expect(bound.create('group-a', 'origin')).rejects.toThrow(); expect(f.client.create).not.toHaveBeenCalled();
  });
  it('retains a cleanup receipt when membership changes during an accepted create', async () => {
    const f = await fixture();
    f.client.create.mockImplementation(async () => { f.state.humans = ['a', 'b']; return { cot_id: 'cot', message_id: 'bubble' }; });
    await expect(f.bound.create('group-a', 'origin')).rejects.toThrow();
    await f.bound.close(); expect(f.client.complete).toHaveBeenCalledWith({ cotId: 'cot', messageId: 'bubble' }, 'interrupted');
    expect(f.client.update).not.toHaveBeenCalled();
  });
  it('rejects foreign destinations, origins and provider IDs', async () => {
    const f = await fixture();
    await f.resources.record(f.operation.context, 'message', 'other-topic-origin');
    await expect(f.bound.create('group-a', 'other-topic-origin')).rejects.toThrow('origin');
    await expect(f.bound.create('group-b', 'origin')).rejects.toThrow('foreign');
    await expect(f.bound.create('group-a', 'foreign-origin')).rejects.toThrow();
    await f.bound.create('group-a', 'origin');
    await expect(f.bound.update({ cotId: 'someone-else', messageId: 'bubble' }, [])).rejects.toThrow('foreign');
    expect(() => f.resources.assertProgressReceipt({ messageId: 'bubble', cotId: 'cot', format: 'cot' } as ProgressReceipt)).toThrow();
    await f.bound.close();
  });
  it('does not emit queued content when observation or policy checks fail', async () => {
    const f = await fixture();
    const check = vi.fn(async () => {});
    const bound = new BoundCotClient({ client: f.client, gate: f.gate, operation: f.operation, context: f.context,
      policyRequired: true, policy: { apiVersion: 1, formats: ['cot'], check } });
    await bound.create('group-a', 'origin');
    check.mockRejectedValueOnce(new Error('policy denied'));
    await expect(bound.update({ cotId: 'cot', messageId: 'bubble' }, [])).rejects.toThrow('policy denied');
    vi.spyOn(f.gate.identity, 'observe').mockRejectedValue(new Error('roster unavailable'));
    await expect(bound.update({ cotId: 'cot', messageId: 'bubble' }, [])).rejects.toThrow('roster unavailable');
    await bound.close();
    expect(f.client.update).not.toHaveBeenCalled();
    expect(f.client.complete).toHaveBeenCalledWith({ cotId: 'cot', messageId: 'bubble' }, 'interrupted');
  });
  it('restores only owned terminal cleanup after restart, without replaying private content', async () => {
    const f = await fixture(true); await f.bound.create('group-a', 'origin');
    const restored = await gateFixture(f.root, { persistent: true }); cleanup.push(() => restored.services.close());
    expect(restored.resources.pendingProgress(f.source.authorityId, 'other-instance')).toEqual([]);
    const [receipt] = restored.resources.pendingProgress(f.source.authorityId, 'primary');
    expect(receipt).toBeDefined(); restored.resources.assertProgressReceipt(receipt!);
    await completeInterrupted(f.client, receipt!); await restored.resources.finishProgress(receipt!);
    expect(f.client.complete).toHaveBeenCalledWith({ cotId: 'cot', messageId: 'bubble' }, 'interrupted');
    expect(f.client.update).not.toHaveBeenCalled();
    expect(restored.resources.pendingProgress(f.source.authorityId, 'primary')).toEqual([]);
  });
});

it('checked card updates share source ownership and replace only status after revocation', async () => {
  const f = await fixture(); const fake = createFakeChannel();
  const terminate = vi.fn(async (receipt: ProgressReceipt) => {
    f.resources.assertProgressReceipt(receipt);
    await fake.updateCardById(receipt.cardId!, interruptedProgressCard(), await f.resources.nextProgressSequence(receipt));
  });
  const card = new ProgressCard({ channel: spaceLarkChannel(fake as unknown as LarkChannel, f.gate),
    gate: f.gate, operation: f.operation, context: f.context, policyRequired: false,
    sendOptions: { replyTo: 'origin' }, terminate });
  await card.update({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'first private detail' }] } });
  f.state.humans = ['a', 'b'];
  await expect(card.update({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'late private detail' }] } })).rejects.toThrow();
  await card.close(); expect(terminate).toHaveBeenCalledOnce();
  expect(JSON.stringify(fake.rawClient.requests)).not.toContain('late private detail');
  expect(JSON.stringify(fake.rawClient.requests)).toContain('本次任务已中止');
});
