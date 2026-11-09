import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { expectedResult, manifest, selectGroups, verifyJar } from '../../../tools/formal/check.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
describe('formal verification gate', () => {
  it('requires a completed successful check and rejects incomplete or failed runs', () => {
    const output = 'Model checking completed. No error has been found.';
    expect(expectedResult({ status: 0, stdout: output })).toBe(true);
    expect(expectedResult({ status: 0, stdout: 'Starting...' })).toBe(false);
    expect(expectedResult({ status: 1, stdout: output })).toBe(false);
    expect(expectedResult({ status: null, stdout: output, signal: 'SIGTERM' })).toBe(false);
    expect(expectedResult({ status: 0, stdout: output, error: new Error('timeout') })).toBe(false);
  });

  it('requires the exact negative-control property and invariant exit status', () => {
    const stdout = 'Invariant Capacity is violated.';
    expect(expectedResult({ status: 12, stdout }, 'Capacity')).toBe(true);
    expect(expectedResult({ status: 12, stdout }, 'Other')).toBe(false);
    for (const status of [0, 1, 150, null]) {
      expect(expectedResult({ status, stdout }, 'Capacity')).toBe(false);
    }
  });

  it('rejects untrusted tool bytes and unknown group names', () => {
    expect(() => verifyJar(Buffer.from('wrong jar'))).toThrow('checksum mismatch');
    expect(() => selectGroups(['typo'])).toThrow('Unknown formal group');
    expect(selectGroups(['pool']).map(group => group.id)).toEqual(['pool']);
    expect(selectGroups([])).toEqual(manifest.groups);
  });

  it('has runnable model/configuration paths and existing implementation evidence', () => {
    const names = new Set<string>();
    for (const group of manifest.groups) {
      expect(group.tests.length).toBeGreaterThan(0);
      for (const path of [...group.source, ...group.tests]) expect(existsSync(root + path), path).toBe(true);
      for (const test of group.cases) {
        expect(names.has(test.name)).toBe(false);
        names.add(test.name);
        expect(existsSync(root + 'tools/formal/' + test.model)).toBe(true);
        expect(Boolean(test.config) !== Boolean(test.configFile)).toBe(true);
        if (test.configFile) expect(existsSync(root + 'tools/formal/' + test.configFile)).toBe(true);
      }
    }
  });

  it('fails closed without tools, and rejects unsupported CLI options', () => {
    const env = { ...process.env };
    delete env.TLA2TOOLS_JAR;
    const missing = spawnSync(process.execPath, ['tools/formal/check.mjs'], { cwd: root, env, encoding: 'utf8' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('TLA2TOOLS_JAR');
    const invalid = spawnSync(process.execPath, ['tools/formal/check.mjs', '--skip'], { cwd: root, env, encoding: 'utf8' });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('Unknown option');
  });

  it('includes complete model checking in integration and publication gates', () => {
    const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'));
    for (const gate of ['ci:local', 'release:validate']) expect(pkg.scripts[gate]).toContain('pnpm formal:check &&');
  });
});
