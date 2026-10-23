import { join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import pkg from '../../package.json';
import { createProfileConversationHost } from '../conversation/profile-host';
import { configureLogger } from '../core/logger';
import { assertIsolatedWorkerEnvironment } from './isolation';
import { AriaWorkerServer } from './server';
import { resolveWorkerProductIdentity, type WorkerProductIdentity } from './identity';

export interface CreateAriaWorkerOptions {
  configPath: string;
  profile: string;
  stateDirectory: string;
  input: Readable;
  output: Writable;
  productIdentity?: WorkerProductIdentity;
}

/** Compose Aria's isolated profile runtime with its channel-neutral worker protocol. */
export async function createAriaWorker(options: CreateAriaWorkerOptions): Promise<{
  serve(): Promise<void>;
  stop(): Promise<void>;
}> {
  if (!options.configPath || !options.profile || !options.stateDirectory) {
    throw new Error('worker configPath, profile and stateDirectory are required');
  }

  assertIsolatedWorkerEnvironment(process.env);
  const productIdentity = resolveWorkerProductIdentity(options.productIdentity);
  const configPath = resolve(options.configPath);
  const stateDirectory = resolve(options.stateDirectory);
  configureLogger({ logsDir: join(stateDirectory, 'logs') });
  const host = await createProfileConversationHost({
    configPath,
    profile: options.profile,
    stateDirectory,
  });
  let server: AriaWorkerServer;
  try {
    server = new AriaWorkerServer({
      input: options.input,
      output: options.output,
      host,
      profile: options.profile,
      workerVersion: pkg.version,
      productIdentity,
    });
  } catch (error) {
    await host.close();
    throw error;
  }

  return {
    serve: () => server.serve(),
    stop: () => server.stop(),
  };
}
