import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// docs/CLI_REFERENCE{,.zh}.md are generated from the Commander declarations in
// src/cli/index.ts. A stale copy would publish commands that no longer exist
// or hide ones that do, so the docs contract requires regeneration in the same
// commit that changes the CLI surface.
describe('CLI reference generation', () => {
  it('keeps the committed CLI reference in sync with src/cli/index.ts', () => {
    const script = fileURLToPath(
      new URL('../../../site/scripts/gen-cli-reference.mjs', import.meta.url),
    );
    expect(() => execFileSync('node', [script, '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});
