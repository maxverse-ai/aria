import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../../src/config/app-paths';
import { SessionCatalog } from '../../../src/session/catalog';
import { nativeReadFactoryFromEnvironment } from '../../../src/runtime/native-read-config';
import { DefaultNativeReadProfileRuntime } from '../../../src/runtime/native-read-runtime';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('nativeReadFactoryFromEnvironment', () => {
  it('keeps the runtime disabled unless explicitly enabled', async () => {
    const factory = await nativeReadFactoryFromEnvironment({
      rootDir: '/not/read', serverVersion: 'test', env: {},
    });
    expect(factory).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('requires a private regular token file', async () => {
    const root = await tempRoot();
    const tokenFile = join(root, 'token');
    await writeFile(tokenFile, 'secret\n', { mode: 0o644 });
    await chmod(tokenFile, 0o644);
    await expect(nativeReadFactoryFromEnvironment({
      rootDir: root,
      serverVersion: 'test',
      env: enabledEnvironment(tokenFile),
    })).rejects.toThrow('mode 0600');
  });

  it('requires explicit allowlisted scopes', async () => {
    const root = await tempRoot();
    const tokenFile = await privateToken(root);
    await expect(nativeReadFactoryFromEnvironment({
      rootDir: root,
      serverVersion: 'test',
      env: { ARIA_NATIVE_READ_ENABLED: 'true', ARIA_NATIVE_READ_TOKEN_FILE: tokenFile },
    })).rejects.toThrow('at least one explicit scope');
    await expect(nativeReadFactoryFromEnvironment({
      rootDir: root,
      serverVersion: 'test',
      env: enabledEnvironment(tokenFile, 'read:sessions,admin:*'),
    })).rejects.toThrow('unsupported native read scope: admin:*');
  });

  it('builds one inert profile runtime from the shared host policy', async () => {
    const root = await tempRoot();
    const tokenFile = await privateToken(root);
    const factory = await nativeReadFactoryFromEnvironment({
      rootDir: root,
      serverVersion: '1.2.3',
      env: enabledEnvironment(tokenFile, 'read:sessions,read:messages,read:sessions'),
    });
    expect(factory).toBeTypeOf('function');
    const paths = resolveAppPaths({ rootDir: root, profile: 'codex' });
    const runtime = await factory!({
      profile: 'codex', appPaths: paths,
      sessionCatalog: new SessionCatalog(join(root, 'catalog.json')),
    });
    expect(runtime).toBeInstanceOf(DefaultNativeReadProfileRuntime);
  });
});

function enabledEnvironment(
  tokenFile: string,
  scopes = 'read:sessions,read:messages,read:message-content,read:runs,read:identities,read:chats,read:audit,read:changes',
): NodeJS.ProcessEnv {
  return {
    ARIA_NATIVE_READ_ENABLED: 'true',
    ARIA_NATIVE_READ_TOKEN_FILE: tokenFile,
    ARIA_NATIVE_READ_SCOPES: scopes,
  };
}

async function privateToken(root: string): Promise<string> {
  const path = join(root, 'token');
  await writeFile(path, 'secret\n', { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aria-native-config-'));
  roots.push(root);
  return root;
}
