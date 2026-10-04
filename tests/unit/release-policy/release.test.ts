import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { normalizeVersions, selectReleasePlan, validatePublishContext } from "../../../tools/release.mjs";

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

describe("publish context", () => {
  const valid = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "maxverse-ai/aria",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: "maxverse-ai/aria/.github/workflows/release.yml@refs/heads/main",
    ARIA_RELEASE_PUBLISH: "true",
  };

  it("accepts only the protected main release workflow", () => {
    expect(validatePublishContext(valid)).toEqual({ ok: true, failures: [] });
    expect(validatePublishContext({ ...valid, GITHUB_REF: "refs/heads/feature" }).ok).toBe(false);
    expect(validatePublishContext({ ...valid, ARIA_RELEASE_PUBLISH: undefined }).ok).toBe(false);
  });

  it("keeps the workflow single-writer, protected, and GitHub-Release-based", () => {
    const workflow = readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");
    const packageJson = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    expect(workflow).toContain("group: aria-release");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: release-production");
    expect(workflow).not.toContain("id-token: write");
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(packageJson.scripts.prepublishOnly).toContain("publish-gate");
  });
});
