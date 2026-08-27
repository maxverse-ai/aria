import type { Readable } from 'node:stream';

interface DrainableChild {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: Pick<Readable, 'readableEnded' | 'destroy'>;
  once(event: 'exit', listener: () => void): unknown;
  removeListener(event: 'exit', listener: () => void): unknown;
}

/**
 * Give stdout a bounded window to deliver data already written by an exited
 * agent. This prevents losing a final JSONL record without allowing a broken
 * inherited stdout descriptor to hold the run open forever.
 */
export function armProcessExitDrain(
  child: DrainableChild,
  closeReader: () => void,
  graceMs = 200,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closeStdoutAfterProcessExit = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      closeReader();
      if (!child.stdout.readableEnded) child.stdout.destroy();
    }, graceMs);
    timer.unref?.();
  };

  if (child.exitCode !== null || child.signalCode !== null) closeStdoutAfterProcessExit();
  else child.once('exit', closeStdoutAfterProcessExit);

  return () => {
    if (timer) clearTimeout(timer);
    child.removeListener('exit', closeStdoutAfterProcessExit);
  };
}
