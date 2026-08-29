import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnInbox } from '../../../src/conversation/turn-inbox';

describe('TurnInbox', () => {
  afterEach(() => vi.useRealTimers());

  it('deduplicates stable message keys and preserves arrival order', () => {
    vi.useFakeTimers();
    const flushed: string[][] = [];
    const inbox = new TurnInbox<string>(100, (_scope, values) => flushed.push(values));

    expect(inbox.offer('scope', 'm1', 'first')).toEqual({ accepted: true, size: 1 });
    expect(inbox.offer('scope', 'm1', 'duplicate')).toEqual({ accepted: false, size: 1 });
    expect(inbox.offer('scope', 'm2', 'second')).toEqual({ accepted: true, size: 2 });

    vi.advanceTimersByTime(100);
    expect(flushed).toEqual([['first', 'second']]);
  });

  it('removes an item only after its steering claim is acknowledged', () => {
    vi.useFakeTimers();
    const flushed: string[][] = [];
    const inbox = new TurnInbox<string>(100, (_scope, values) => flushed.push(values));
    inbox.block('scope');
    inbox.offer('scope', 'm1', 'first');

    const claim = inbox.claim('scope', ['m1'], 'steer:m1');
    expect(claim?.items).toEqual([{ key: 'm1', value: 'first' }]);
    expect(inbox.activitySnapshot().claimedMessages).toBe(1);
    expect(claim && inbox.acknowledge(claim)).toBe(1);

    inbox.unblock('scope');
    vi.advanceTimersByTime(500);
    expect(flushed).toEqual([]);
    expect(inbox.activitySnapshot().pendingMessages).toBe(0);
  });

  it('releases a failed steering claim back to the debounced next turn', () => {
    vi.useFakeTimers();
    const flushed: string[][] = [];
    const inbox = new TurnInbox<string>(100, (_scope, values) => flushed.push(values));
    inbox.block('scope');
    inbox.offer('scope', 'm1', 'first');
    const claim = inbox.claim('scope', ['m1'], 'steer:m1');
    expect(claim).toBeDefined();

    expect(claim && inbox.release(claim)).toBe(1);
    vi.advanceTimersByTime(500);
    expect(flushed).toEqual([]);

    inbox.unblock('scope');
    vi.advanceTimersByTime(99);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([['first']]);
  });

  it('does not flush claimed items alongside ordinary queued items', () => {
    vi.useFakeTimers();
    const flushed: string[][] = [];
    const inbox = new TurnInbox<string>(100, (_scope, values) => flushed.push(values));
    inbox.offer('scope', 'm1', 'steering');
    inbox.offer('scope', 'm2', 'next turn');
    const claim = inbox.claim('scope', ['m1'], 'steer:m1');

    vi.advanceTimersByTime(100);
    expect(flushed).toEqual([['next turn']]);
    expect(inbox.activitySnapshot()).toMatchObject({ pendingMessages: 1, claimedMessages: 1 });

    expect(claim && inbox.release(claim)).toBe(1);
    vi.advanceTimersByTime(100);
    expect(flushed).toEqual([['next turn'], ['steering']]);
  });
});
