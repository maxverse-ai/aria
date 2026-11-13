import { resolve } from 'node:path';
import { runDaemonHost } from './host';

// Internal packaged entry; not a public CLI command or a general subprocess API.
const [serviceId, directory, runtimePath, entry, ...runArgs] = process.argv.slice(2);
if (!serviceId || !directory || !runtimePath || !entry || runArgs[0] !== 'run') {
  throw new Error('Invalid internal daemon launch specification');
}
await runDaemonHost({serviceId, directory: resolve(directory), runtimePath, ...(entry !== '-' ? {entry} : {}), runArgs});
