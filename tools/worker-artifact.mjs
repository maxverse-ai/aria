#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = resolve(root, process.argv[3] ?? 'artifacts');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function validateWorkerManifest(manifest, { version, commit }) {
  if (!manifest || manifest.schemaVersion !== 1 || manifest.kind !== 'aria-worker' ||
      manifest.repository !== 'maxverse-ai/aria' || manifest.version !== version || manifest.commit !== commit ||
      manifest.protocolVersion !== 1 || manifest.entry !== 'worker/index.js' ||
      typeof manifest.tarball !== 'string' || basename(manifest.tarball) !== manifest.tarball ||
      !/^aria-worker-\d+\.\d+\.\d+\.tgz$/.test(manifest.tarball) || !/^[0-9a-f]{64}$/.test(manifest.sha256)) {
    throw new Error('worker artifact manifest does not match the expected release identity');
  }
  return manifest;
}

function manifestFor(tarball) {
  return validateWorkerManifest({
    schemaVersion: 1,
    kind: 'aria-worker',
    repository: 'maxverse-ai/aria',
    version: packageJson.version,
    commit,
    protocolVersion: 1,
    entry: 'worker/index.js',
    tarball: basename(tarball),
    sha256: sha256(tarball),
  }, { version: packageJson.version, commit });
}

function payloadManifest() {
  const worker = join(root, 'dist', 'worker.js');
  return {
    schemaVersion: 1,
    kind: 'aria-worker',
    repository: 'maxverse-ai/aria',
    version: packageJson.version,
    commit,
    protocolVersion: 1,
    entry: 'worker/index.js',
    workerSha256: sha256(worker),
  };
}

function build() {
  const worker = join(root, 'dist', 'worker.js');
  if (!existsSync(worker)) throw new Error('dist/worker.js is missing; run pnpm build first');
  mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), 'aria-worker-'));
  try {
    mkdirSync(join(staging, 'worker'), { recursive: true });
    cpSync(worker, join(staging, 'worker', 'index.js'));
    cpSync(join(root, 'LICENSE'), join(staging, 'LICENSE'));
    writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(payloadManifest(), null, 2)}\n`);
    const tarball = join(output, `aria-worker-${packageJson.version}.tgz`);
    execFileSync('tar', ['-czf', tarball, '-C', staging, 'worker', 'LICENSE', 'manifest.json']);
    const manifest = manifestFor(tarball);
    writeFileSync(join(output, 'aria-worker-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(join(output, 'aria-worker-SHA256SUMS'), `${manifest.sha256}  ${basename(tarball)}\n`);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function verify() {
  const manifest = JSON.parse(readFileSync(join(output, 'aria-worker-manifest.json'), 'utf8'));
  const tarball = join(output, manifest.tarball);
  if (!statSync(tarball).isFile() || sha256(tarball) !== manifest.sha256) {
    throw new Error('worker artifact SHA-256 does not match its manifest');
  }
  validateWorkerManifest(manifest, { version: packageJson.version, commit });
  const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  const entries = listing.split(/\r?\n/);
  if (!entries.includes('worker/index.js') || !entries.includes('LICENSE')) {
    throw new Error('worker artifact is missing required files');
  }
  process.stdout.write(`${JSON.stringify({ ok: true, ...manifest }, null, 2)}\n`);
}

function main() {
  const operation = process.argv[2];
  if (operation === 'build') return build();
  if (operation === 'verify') return verify();
  throw new Error('worker-artifact command must be build or verify');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
