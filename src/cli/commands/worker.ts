import { resolve } from 'node:path';
import pkg from '../../../package.json';
import { createProfileConversationHost } from '../../conversation/profile-host';
import { configureLogger } from '../../core/logger';
import { assertIsolatedWorkerEnvironment } from '../../worker/isolation';
import { AriaWorkerServer } from '../../worker/server';

export interface RunWorkerOptions {
  config?: string;
  profile?: string;
  stateDir?: string;
}

/** Run a headless, channel-free Aria worker on newline-delimited JSON-RPC. */
export async function runWorker(options: RunWorkerOptions): Promise<void> {
  assertIsolatedWorkerEnvironment(process.env);
  if (!options.config) throw new Error('--config is required');
  if (!options.profile) throw new Error('--profile is required');
  if (!options.stateDir) throw new Error('--state-dir is required');

  const stateDirectory = resolve(options.stateDir);
  configureLogger({ logsDir: resolve(stateDirectory, 'logs') });

  // stdout is the protocol transport. Aria's human-readable runtime log lines
  // must never corrupt it when a managed run starts or completes.
  console.log = (...args: unknown[]) => console.error(...args);

  const host = await createProfileConversationHost({
    configPath: resolve(options.config),
    profile: options.profile,
    stateDirectory,
  });
  const server = new AriaWorkerServer({
    input: process.stdin,
    output: process.stdout,
    host,
    profile: options.profile,
    workerVersion: pkg.version,
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
