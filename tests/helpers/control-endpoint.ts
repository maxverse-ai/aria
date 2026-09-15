import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/**
 * Runtime control listens on a unix socket path on POSIX and on a named pipe on
 * Windows, mirroring `resolveAppPaths().runtimeControlEndpoint`. A test that
 * starts the control server directly must pass the same shape, or the listen
 * fails with EACCES on Windows.
 */
export function controlEndpoint(directory: string, name = 'control'): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\aria-test-${name}-${randomUUID()}`
    : join(directory, `${name}.sock`);
}
