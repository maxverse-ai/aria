import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  UI_ALLOWED_ORIGINS_ENV,
  UI_PORT_ENV,
  UI_TOKEN_FILE_ENV,
  uiEnvironment,
} from '../../../src/ui/environment';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tokenFile(mode = 0o600): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'aria-ui-environment-'));
  roots.push(root);
  const path = join(root, 'token');
  await writeFile(path, `${'ab'.repeat(32)}\n`, { mode });
  await chmod(path, mode);
  return path;
}

describe('UI reverse-proxy environment', () => {
  it('preserves safe local defaults when no opt-in variables are set', async () => {
    await expect(uiEnvironment({})).resolves.toEqual({});
  });

  it('loads a fixed port, private token, and exact allowed origins', async () => {
    const path = await tokenFile();
    await expect(uiEnvironment({
      [UI_PORT_ENV]: '5274',
      [UI_TOKEN_FILE_ENV]: path,
      [UI_ALLOWED_ORIGINS_ENV]: 'https://console.example.com,https://ops.example.com',
    })).resolves.toEqual({
      port: 5274,
      token: 'ab'.repeat(32),
      allowedOrigins: ['https://console.example.com', 'https://ops.example.com'],
    });
  });

  it('rejects invalid ports, origins, tokens, and broad token permissions', async () => {
    await expect(uiEnvironment({ [UI_PORT_ENV]: '0' })).rejects.toThrow(UI_PORT_ENV);
    await expect(uiEnvironment({ [UI_ALLOWED_ORIGINS_ENV]: 'https://example.com/path' })).rejects.toThrow(
      UI_ALLOWED_ORIGINS_ENV,
    );

    const invalidRoot = await mkdtemp(join(tmpdir(), 'aria-ui-environment-'));
    roots.push(invalidRoot);
    const invalidPath = join(invalidRoot, 'token');
    await writeFile(invalidPath, 'not-a-token', { mode: 0o600 });
    await expect(uiEnvironment({ [UI_TOKEN_FILE_ENV]: invalidPath })).rejects.toThrow(UI_TOKEN_FILE_ENV);

    if (process.platform !== 'win32') {
      const broadPath = await tokenFile(0o640);
      await expect(uiEnvironment({ [UI_TOKEN_FILE_ENV]: broadPath })).rejects.toThrow(
        /must not be accessible/,
      );
    }
  });
});
