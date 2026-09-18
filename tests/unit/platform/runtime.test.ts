import { describe, expect, it } from 'vitest';
import { buildUnit } from '../../../src/daemon/systemd';
import { isBunRuntime, isCompiledRuntime, runtimeEntryPath, type JsRuntime } from '../../../src/platform/runtime';
import { runtimeNotice } from '../../../src/cli/node-version';

describe('JS runtime detection', () => {
  it('treats a missing or embedded entry as runtime-only launch', () => {
    expect(runtimeEntryPath(['bun', '/$bunfs/root/aria'])).toBeUndefined();
    expect(runtimeEntryPath(['bun'])).toBeUndefined();
    expect(runtimeEntryPath(['bun', 'B:\\~BUN\\root\\aria'])).toBeUndefined();
    expect(runtimeEntryPath(['node', '/opt/aria/bin/aria.mjs', 'run'])).toBe('/opt/aria/bin/aria.mjs');
    expect(runtimeEntryPath(['bun', '/opt/aria/bin/aria.mjs', 'run'])).toBe('/opt/aria/bin/aria.mjs');
  });

  it('detects compiled-binary mode only under bun with an embedded entry', () => {
    const compiled = isCompiledRuntime(['aria', '/$bunfs/root/aria', 'run']);
    const scripted = isCompiledRuntime(['bun', '/opt/aria/bin/aria.mjs', 'run']);
    // The argv signal alone decides once the bun runtime is present; under
    // node the result is always false regardless of argv shape.
    expect(compiled).toBe(isBunRuntime());
    expect(scripted).toBe(false);
    expect(isCompiledRuntime(['node', '/opt/aria/bin/aria.mjs', 'run'])).toBe(false);
  });
});

describe('runtimeNotice', () => {
  it('accepts supported node and bun runtimes', () => {
    const node: JsRuntime = { kind: 'node', execPath: '/usr/bin/node', version: '24.1.0', reportedVersion: 'v24.1.0' };
    const bun: JsRuntime = { kind: 'bun', execPath: '/usr/bin/bun', version: '1.4.0', reportedVersion: '1.4.0' };
    expect(runtimeNotice(node)).toBeUndefined();
    expect(runtimeNotice(bun)).toBeUndefined();
  });

  it('warns on outdated node or bun runtimes', () => {
    const node: JsRuntime = { kind: 'node', execPath: '/usr/bin/node', version: '22.9.0', reportedVersion: 'v22.9.0' };
    const bun: JsRuntime = { kind: 'bun', execPath: '/usr/bin/bun', version: '0.9.0', reportedVersion: '0.9.0' };
    expect(runtimeNotice(node)).toContain('requires Node 24');
    expect(runtimeNotice(bun)).toContain('requires Bun 1');
  });
});

describe('systemd unit generation across runtimes', () => {
  const base = {
    runtimePath: '/usr/local/bin/bun',
    bridgeEntryPath: '/repo/bin/aria.mjs',
    envPath: '/usr/local/bin:/usr/bin',
    profile: 'devin',
    runArgs: ['run', '--profile', 'devin'],
    channelHome: '/tmp/lark-channel-home',
  };

  it('embeds a bun runtime path and the bridge entry', () => {
    const unit = buildUnit(base);
    expect(unit).toContain('ExecStart="/usr/local/bin/bun" "/repo/bin/aria.mjs" run --profile devin');
  });

  it('omits the entry argument when the runtime binary is self-contained', () => {
    const unit = buildUnit({ ...base, runtimePath: '/usr/local/bin/aria', bridgeEntryPath: undefined });
    expect(unit).toContain('ExecStart="/usr/local/bin/aria" run --profile devin');
    expect(unit).not.toContain('aria.mjs');
  });
});
