import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

const buildIdentity = { ARIA_BUILD_COMMIT: JSON.stringify(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()) };

export default defineConfig([
  {
    entry: {
      cli: 'src/cli/index.ts',
      updater: 'src/updater/index.ts',
    },
    outDir: 'dist',
    define: buildIdentity,
    format: ['esm'],
    target: 'node24',
    platform: 'node',
    clean: true,
    sourcemap: false,
    splitting: false,
    dts: false,
    // Inline the Vite-built console (src/ui/generated/index.html) as a string.
    esbuildOptions(options) {
      options.loader = { ...options.loader, '.html': 'text' };
    },
  },
  {
    entry: { installer: 'src/installer/index.ts' },
    outDir: 'dist',
    define: buildIdentity,
    format: ['esm'],
    target: 'node24',
    platform: 'node',
    sourcemap: false,
    splitting: false,
    dts: false,
    // This file is copied byte-for-byte to GitHub Releases as aria-install.mjs.
    // Unlike the packaged CLI/updater, it has no adjacent node_modules tree.
    noExternal: [/.*/],
    // Bundled CommonJS dependencies such as cross-spawn still require Node
    // builtins at runtime. Give esbuild's ESM require shim a native require.
    banner: {
      js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);",
    },
  },
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    define: buildIdentity,
    format: ['esm'],
    target: 'node24',
    platform: 'node',
    sourcemap: false,
    splitting: false,
    dts: true,
  },
  {
    entry: { worker: 'src/worker/index.ts' },
    outDir: 'dist',
    define: buildIdentity,
    format: ['esm'],
    target: 'node24',
    platform: 'node',
    clean: false,
    sourcemap: false,
    splitting: false,
    dts: true,
    noExternal: [/.*/],
    esbuildOptions(options) {
      options.alias = {
        ...(options.alias ?? {}),
        'qrcode-terminal': resolve('src/worker/qrcode-terminal-stub.ts'),
      };
    },
  },
]);
