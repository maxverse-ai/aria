import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveInstallPaths } from '../../../src/platform/distribution/install-layout.js';

describe('distribution install layout', () => {
  it('keeps executable versions outside ARIA_HOME profile state', () => {
    const paths = resolveInstallPaths({
      env: { ARIA_HOME: '/state/aria', XDG_DATA_HOME: '/data', XDG_BIN_HOME: '/commands' },
      homeDir: '/home/aria',
      platform: 'linux',
      pathApi: posix,
    });
    expect(paths.root).toBe('/data/aria/cli');
    expect(paths.commandFile).toBe('/commands/aria');
    expect(paths.root).not.toContain('/state/aria');
  });

  it('uses a self-contained Windows installation root', () => {
    const paths = resolveInstallPaths({
      env: { LOCALAPPDATA: 'C:\\Users\\aria\\AppData\\Local' },
      homeDir: 'C:\\Users\\aria',
      platform: 'win32',
      pathApi: win32,
    });
    expect(paths.root).toBe('C:\\Users\\aria\\AppData\\Local\\Aria\\cli');
    expect(paths.commandFile).toBe('C:\\Users\\aria\\AppData\\Local\\Aria\\cli\\bin\\aria.cmd');
  });
});
