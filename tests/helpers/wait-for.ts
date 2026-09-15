/**
 * Poll a predicate until it holds.
 *
 * The budget is deliberately generous: these tests observe asynchronous run
 * completion, and a loaded CI runner can take seconds where a developer machine
 * takes milliseconds. A short budget turns "slow host" into "broken code".
 */
export async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for async work');
}
