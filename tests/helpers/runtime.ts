import { execFileSync } from 'node:child_process';
import { currentRuntime } from '../../src/platform/runtime';

/**
 * Version string the current runtime's `--version` flag prints. Deployment
 * probes match `binary --version` output against `binaryVersion`, and under
 * bun `process.version` is the emulated node version (`v24.x`) while
 * `bun --version` prints `1.x` — so fixtures must use the reported version.
 */
export const runtimeProbeVersion = currentRuntime.reportedVersion;

/**
 * Absolute path of a real node binary for fixture fields that must probe
 * `v24+` output (`queryNode`). Under node this is the test process itself;
 * under bun the spawned `bun --version` output cannot satisfy the
 * node-version regex, so resolve `node` through PATH (present in every
 * dev/CI env that can run the suite).
 */
export const nodeHelperBinary = currentRuntime.kind === 'bun'
  ? execFileSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8' }).trim().split('\n')[0]!
  : process.execPath;
