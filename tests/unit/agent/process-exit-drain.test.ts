import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { armProcessExitDrain } from '../../../src/agent/process-exit-drain.js';

function child(exited = false) {
  const events = new EventEmitter();
  const stdout = {
    readableEnded: false,
    destroy: vi.fn(),
  };
  return Object.assign(events, {
    exitCode: exited ? 0 : null,
    signalCode: null,
    stdout,
  });
}

describe('agent process exit drain', () => {
  it('allows the bounded grace window before closing stdout', () => {
    vi.useFakeTimers();
    const proc = child();
    const closeReader = vi.fn();
    const cleanup = armProcessExitDrain(proc, closeReader, 200);

    proc.emit('exit', 0, null);
    vi.advanceTimersByTime(199);
    expect(closeReader).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(closeReader).toHaveBeenCalledOnce();
    expect(proc.stdout.destroy).toHaveBeenCalledOnce();

    cleanup();
    vi.useRealTimers();
  });

  it('arms immediately when the child exited before the reader was attached', () => {
    vi.useFakeTimers();
    const proc = child(true);
    const closeReader = vi.fn();
    armProcessExitDrain(proc, closeReader, 200);

    vi.advanceTimersByTime(200);
    expect(closeReader).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('cancels the timer when normal stdout completion wins', () => {
    vi.useFakeTimers();
    const proc = child();
    const closeReader = vi.fn();
    const cleanup = armProcessExitDrain(proc, closeReader, 200);
    proc.emit('exit', 0, null);
    cleanup();

    vi.advanceTimersByTime(200);
    expect(closeReader).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
