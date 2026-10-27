import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeVersions, selectReleasePlan, validatePublishContext, validateOrigin, withReleaseLock } from "../../../tools/release.mjs";

const policy = {
  schemaVersion: 1,
  stableLine: "0.1",
  patchMode: "automatic",
  batchWindowMinutes: 30,
  securityPatchMode: "immediate",
  prereleaseMode: "automatic",
  requireHumanForMinor: true,
  requireHumanForMajor: true,
  requireHumanForStablePromotion: true,
  frozen: false,
};

describe("trusted release planning", () => {
  it("uses the committed package version for the first protected publication", () => {
    expect(selectReleasePlan({ packageVersion: "0.1.1", policy })).toMatchObject({
      ok: true,
      kind: "initial",
      target: "0.1.1",
      needsVersionChange: false,
      humanRequired: true,
    });
  });

  it("automatically plans exactly one patch after a synchronized release", () => {
    expect(selectReleasePlan({
      packageVersion: "0.1.1",
      policy,
      taggedVersions: ["0.1.1"],
      publishedVersions: ["0.1.0", "0.1.1"],
    })).toMatchObject({ ok: true, kind: "patch", from: "0.1.1", target: "0.1.2", needsVersionChange: true });
  });

  it("recognizes a merged patch release commit as ready to publish", () => {
    expect(selectReleasePlan({
      packageVersion: "0.1.2",
      policy,
      taggedVersions: ["0.1.1"],
      publishedVersions: ["0.1.1"],
    })).toMatchObject({ ok: true, target: "0.1.2", needsVersionChange: false });
  });

  it("stops on tag and registry divergence or an unauthorized version jump", () => {
    expect(() => selectReleasePlan({
      packageVersion: "0.1.2",
      policy,
      taggedVersions: ["0.1.0"],
      publishedVersions: ["0.1.1"],
    })).toThrow(/diverged/);
    expect(() => selectReleasePlan({
      packageVersion: "0.1.1",
      policy,
      publishedVersions: ["0.1.1"],
    })).toThrow(/tag is missing/);
    expect(selectReleasePlan({
      packageVersion: "0.1.3",
      policy,
      taggedVersions: ["0.1.1"],
      publishedVersions: ["0.1.1"],
    }).ok).toBe(false);
  });

  it("sorts and deduplicates semantic versions", () => {
    expect(normalizeVersions(["0.1.10", "0.1.2", "0.1.2-rc.10", "0.1.2-rc.2", "0.1.2"])).toEqual([
      "0.1.2-rc.2",
      "0.1.2-rc.10",
      "0.1.2",
      "0.1.10",
    ]);
  });
});

describe("host-local publication", () => {
  it("confines publishing to canonical origin URLs", () => {
    expect(validateOrigin("https://github.com/maxverse-ai/aria.git")).toBe(true);
    expect(validateOrigin("git@github.com:maxverse-ai/aria.git")).toBe(true);
    for (const origin of ["https://github.com/other/aria.git", "https://github.com/maxverse-ai/aria.git.evil", "https://github.com.evil/maxverse-ai/aria.git"])
      expect(validateOrigin(origin)).toBe(false);
  });

  it("excludes concurrent worktree releases and releases the lock on failure", () => {
    const directory = mkdtempSync(join(tmpdir(), "aria-release-lock-"));
    try {
      expect(() => withReleaseLock(directory, () => {
        expect(existsSync(join(directory, "aria-local-release.lock", "owner.json"))).toBe(true);
        expect(() => withReleaseLock(directory, () => undefined)).toThrow(/another local release/);
        throw new Error("gate failed");
      })).toThrow("gate failed");
      expect(existsSync(join(directory, "aria-local-release.lock"))).toBe(false);
      expect(withReleaseLock(directory, () => "released")).toBe("released");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("accepts local execution without fabricated Actions variables and rejects CI", () => {
    expect(validatePublishContext({})).toEqual({ ok: true, failures: [] });
    expect(validatePublishContext({ GITHUB_ACTIONS: "true" }).ok).toBe(false);
    expect(validatePublishContext({ CI: "true" }).ok).toBe(false);
  });

  it("runs validation inside the repository lock before draft upload and publication", () => {
    const source = readFileSync(new URL("../../../tools/release.mjs", import.meta.url), "utf8");
    expect(source).toContain('withReleaseLock(commonDirectory');
    expect(source).toContain('["ci:local"]');
    expect(source).toContain('["artifact:verify"]');
    expect(source).toContain('"--draft"');
    expect(source).toContain('"--draft=false"');
    expect(source).toContain('published.immutable !== true');
    expect(source.indexOf('release tag appeared with a different commit')).toBeLessThan(source.indexOf('"--draft=false"'));
    expect(source.indexOf('draft release assets no longer match')).toBeLessThan(source.indexOf('"--draft=false"'));
    expect(source).not.toContain('ARIA_RELEASE_PUBLISH');
  });
});

describe("release notes rendering", () => {
  it("rewrites relative links to absolute blob URLs at the release tag", async () => {
    const { renderReleaseNotes } = await import("../../../tools/release.mjs");
    const out = renderReleaseNotes("docs/releases/v0.4.0.md", "v0.4.0");
    expect(out).toContain(
      "](https://github.com/maxverse-ai/aria/blob/v0.4.0/docs/releases/v0.4.0.zh.md)",
    );
    expect(out).toContain(
      "](https://github.com/maxverse-ai/aria/blob/v0.4.0/docs/install-and-upgrade.md)",
    );
    expect(out).not.toMatch(/\]\((?!https?:)[^)]*\.md\)/);
  });
});
