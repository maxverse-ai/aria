import { resolve } from 'node:path';
import { createAriaWorker } from '../../worker/embed';
import { assertIsolatedWorkerEnvironment } from '../../worker/isolation';
import { resolveWorkerProductIdentity } from '../../worker/identity';

export interface RunWorkerOptions {
  config?: string;
  profile?: string;
  stateDir?: string;
  productId?: string;
  productName?: string;
}

/** Run a headless, channel-free Aria worker on newline-delimited JSON-RPC. */
export async function runWorker(options: RunWorkerOptions): Promise<void> {
  assertIsolatedWorkerEnvironment(process.env);
  if (!options.config) throw new Error('--config is required');
  if (!options.profile) throw new Error('--profile is required');
  if (!options.stateDir) throw new Error('--state-dir is required');
  if ((options.productId !== undefined) !== (options.productName !== undefined)) {
    throw new Error('--product-id and --product-name must be provided together');
  }

  const productIdentity = resolveWorkerProductIdentity(
    options.productId !== undefined && options.productName !== undefined
      ? { id: options.productId, displayName: options.productName }
      : undefined,
  );
  const stateDirectory = resolve(options.stateDir);

  // stdout is the protocol transport. Aria's human-readable runtime log lines
  // must never corrupt it when a managed run starts or completes.
  console.log = (...args: unknown[]) => console.error(...args);

  const server = await createAriaWorker({
    configPath: resolve(options.config),
    profile: options.profile,
    stateDirectory,
    input: process.stdin,
    output: process.stdout,
    productIdentity,
  });
  const shutdown = (): void => { void server.stop(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await server.serve();
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await server.stop();
  }
}
