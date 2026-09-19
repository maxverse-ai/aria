import { describe, expect, it } from 'vitest';
import { LoopStore } from '../../../src/bot/loop-store';
import type { ConversationInput } from '../../../src/bot/conversation-input';

function template(content = '/loop --max 3 修完所有 lint 错误'): ConversationInput {
  return {
    message: {
      messageId: 'om_origin',
      chatId: 'oc_1',
      content,
      createTime: 1,
      senderId: 'ou_user',
      chatType: 'p2p',
      mentions: [{ openId: 'ou_bot' }],
      resources: [{ kind: 'file' }],
    } as unknown as ConversationInput['message'],
    addressing: { kind: 'dm' } as unknown as ConversationInput['addressing'],
  };
}

describe('LoopStore', () => {
  it('starts, reports, and stops a loop', () => {
    const loops = new LoopStore();
    const state = loops.start('s', template(), 'prompt', 3);
    expect(state).toMatchObject({ prompt: 'prompt', remaining: 3, total: 3 });
    expect(loops.get('s')).toBe(state);
    expect(loops.stop('s')).toBe(state);
    expect(loops.get('s')).toBeUndefined();
    expect(loops.stop('s')).toBeUndefined();
  });

  it('queues the next iteration while budget remains', () => {
    const loops = new LoopStore();
    loops.start('s', template(), 'prompt', 3);
    const next = loops.afterRun('s', 'done');
    expect(next?.kind).toBe('continue');
    if (next?.kind !== 'continue') return;
    expect(next.state.remaining).toBe(2);
    expect(next.input.message.content).toBe('prompt');
    expect(next.input.message.messageId).not.toBe('om_origin');
    expect(next.input.message.messageId).toContain('loop:oc_1:');
    expect(next.input.message.resources).toEqual([]);
    expect(next.input.message.mentions).toEqual([]);
    expect(next.input.message.chatId).toBe('oc_1');
  });

  it('finishes after the last iteration', () => {
    const loops = new LoopStore();
    loops.start('s', template(), 'prompt', 2);
    expect(loops.afterRun('s', 'done')?.kind).toBe('continue');
    const last = loops.afterRun('s', 'done');
    expect(last?.kind).toBe('finished');
    if (last?.kind === 'finished') expect(last.replyTo).toBe('om_origin');
    expect(loops.get('s')).toBeUndefined();
  });

  it('aborts the loop when a run does not end done', () => {
    for (const terminal of ['interrupted', 'error', 'idle_timeout', undefined] as const) {
      const loops = new LoopStore();
      loops.start('s', template(), 'prompt', 5);
      const result = loops.afterRun('s', terminal);
      expect(result?.kind).toBe('aborted');
      if (result?.kind === 'aborted') expect(result.terminal).toBe(terminal ?? 'error');
      expect(loops.get('s')).toBeUndefined();
    }
  });

  it('pauses before queueing and resumes the owed iteration', () => {
    const loops = new LoopStore();
    loops.start('s', template(), 'prompt', 3);
    loops.pause('s');
    expect(loops.get('s')!.paused).toBe(true);

    const after = loops.afterRun('s', 'done');
    expect(after?.kind).toBe('paused');
    expect(after?.state.remaining).toBe(2);

    const resumed = loops.resume('s');
    expect(resumed?.input).toBeDefined();
    expect(resumed?.input?.message.content).toBe('prompt');
    expect(resumed?.state.paused).toBe(false);

    // Resumed iteration runs to completion and continues normally.
    const next = loops.afterRun('s', 'done');
    expect(next?.kind).toBe('continue');
    expect(next?.state.remaining).toBe(1);
  });

  it('resume while a run is in flight owes no input', () => {
    const loops = new LoopStore();
    loops.start('s', template(), 'prompt', 3);
    loops.pause('s');
    const resumed = loops.resume('s');
    expect(resumed?.input).toBeUndefined();
    // The in-flight run's afterRun queues the next iteration itself.
    expect(loops.afterRun('s', 'done')?.kind).toBe('continue');
  });

  it('ignores scopes without a loop', () => {
    const loops = new LoopStore();
    expect(loops.afterRun('nope', 'done')).toBeUndefined();
  });
});
