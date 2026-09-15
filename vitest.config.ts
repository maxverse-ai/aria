import { configDefaults, defineConfig } from "vitest/config";

// Execution spaces provision POSIX process, path and socket state and are
// declared Linux-only by `assertSpaceHostSupported`. Their suites therefore run
// only on the hosts that can support them; everything else stays cross-platform.
const spaceSuites = [
  "tests/unit/space/**",
  "tests/unit/execution/**",
  "tests/unit/lark-cli/local-migration.test.ts",
  "tests/unit/lark-cli/space-credentials.test.ts",
  "tests/process/space-*.test.ts",
  "tests/integration/bot/space-channel.test.ts",
];

// Match tsup's `.html` text loader (tsup.config.ts) so `import html from
// './generated/index.html'` returns the file's contents as a string under
// vitest too. Without this, vite's import-analysis tries to parse the built
// console HTML as JS and fails.
export default defineConfig({
  test: {
    // The suite runs real filesystem and subprocess work under a parallel CI
    // matrix; vitest's five-second default reads a loaded runner as a broken
    // test. A genuinely hung test still fails, just later.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    ...(process.platform === "win32" ? { fileParallelism: false } : {}),
    ...(process.platform === "linux" ? {} : { exclude: [...configDefaults.exclude, ...spaceSuites] }),
  },
  plugins: [
    {
      name: "html-string-loader",
      enforce: "pre",
      transform(code: string, id: string) {
        if (id.endsWith(".html")) {
          return { code: `export default ${JSON.stringify(code)};`, map: null };
        }
        return null;
      },
    },
  ],
});
