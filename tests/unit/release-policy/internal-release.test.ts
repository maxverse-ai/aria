import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createInternalReleasePlan,
  createReleaseManifest,
  internalTagForVersion,
  releaseLineAuthorization,
  validateInternalReleaseContext,
} from "../../../tools/internal-release.mjs";

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

const commit = "a".repeat(40);
const digest = "b".repeat(64);

describe("internal GitHub release planning", () => {
  it("uses a namespace that cannot collide with formal v* package tags", () => {
    expect(internalTagForVersion("0.1.2")).toBe("internal-v0.1.2");
    expect(() => internalTagForVersion("0.1.2-rc.1")).toThrow(/stable package version/);
  });

  it("accepts an exact verified artifact on the authorized line", () => {
    expect(createInternalReleasePlan({
      packageJson: { name: "@maxverse-ai/aria", version: "0.1.2" },
      policy,
      manifest: {
        kind: "ci-candidate",
        packageName: "@maxverse-ai/aria",
        version: "0.1.2",
        commit,
        sha256: digest,
      },
      commit,
      digest,
      notes: "# Aria Internal v0.1.2",
    })).toMatchObject({
      ok: true,
      version: "0.1.2",
      tag: "internal-v0.1.2",
      title: "Aria Internal v0.1.2",
    });
  });

  it("creates a machine-readable install contract from the exact candidate", () => {
    const packageJson = { name: "@maxverse-ai/aria", version: "0.1.2", engines: { node: ">=20.12.0" } };
    const manifest = { tarball: "maxverse-ai-aria-0.1.2.tgz" };
    const plan = {
      ok: true,
      tag: "internal-v0.1.2",
      version: "0.1.2",
      commit,
    };
    expect(createReleaseManifest({
      packageJson,
      plan,
      manifest,
      digest,
      createdAt: "2026-08-29T00:00:00.000Z",
    })).toMatchObject({
      schemaVersion: 1,
      channel: "internal",
      tag: plan.tag,
      commit,
      sha256: digest,
      nodeRange: ">=20.12.0",
      stateSchemaVersion: 1,
    });
  });

  it("fails closed on artifact, policy, or release-note drift", () => {
    const result = createInternalReleasePlan({
      packageJson: { name: "@maxverse-ai/aria", version: "0.1.2" },
      policy: { ...policy, frozen: true },
      manifest: {
        kind: "other",
        packageName: "wrong",
        version: "0.1.1",
        commit: "c".repeat(40),
        sha256: "d".repeat(64),
      },
      commit,
      digest,
      notes: " ",
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(expect.arrayContaining([
      "release policy is frozen",
      "artifact must be a verified CI candidate",
      "artifact package name does not match package.json",
      "artifact version does not match package.json",
      "artifact commit does not match the exact main commit",
      "artifact digest does not match its manifest",
      "internal release notes are empty",
    ]));
  });
});

describe("internal release workflow boundary", () => {
  const valid = {
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "maxverse-ai/aria",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW_REF: "maxverse-ai/aria/.github/workflows/internal-release.yml@refs/heads/main",
    ARIA_INTERNAL_RELEASE: "true",
  };

  it("accepts only the dedicated main-branch workflow", () => {
    expect(validateInternalReleaseContext(valid)).toEqual({ ok: true, failures: [] });
    expect(validateInternalReleaseContext({ ...valid, GITHUB_REF: "refs/heads/feature" }).ok).toBe(false);
    expect(validateInternalReleaseContext({ ...valid, GITHUB_WORKFLOW_REF: "release.yml" }).ok).toBe(false);
  });

  it("is GitHub-only, single-writer, draft-first, and has durable notes", () => {
    const workflow = readFileSync(new URL("../../../.github/workflows/internal-release.yml", import.meta.url), "utf8");
    const notes = readFileSync(new URL("../../../docs/releases/v0.1.2.md", import.meta.url), "utf8");
    expect(workflow).toContain("group: aria-internal-release");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("--draft");
    expect(workflow).toContain("--prerelease=true");
    expect(workflow).toContain("--latest=false");
    expect(workflow).toContain("steps.internal.outputs.checksums");
    expect(workflow).toContain("steps.internal.outputs.releaseManifest");
    expect(workflow).toContain("steps.internal.outputs.installer");
    expect(workflow).toContain(".immutable");
    expect(workflow).not.toContain("npm publish");
    expect(workflow).not.toContain("id-token: write");
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(notes).toMatch(/not\r?\npublished to npm/);
    expect(notes).toContain("Physical state migration");
  });
});

describe("release line authorization", () => {
  const advance = "chore(release): prepare internal v0.4.0";

  it("asks nothing when the release line does not move", () => {
    expect(releaseLineAuthorization({ stableLine: "0.3", previousLine: "0.3", commitMessage: advance }))
      .toEqual({ ok: true, required: null, failures: [] });
  });

  it("asks nothing for the first release, which has no previous line", () => {
    expect(releaseLineAuthorization({ stableLine: "0.1", previousLine: null, commitMessage: advance }))
      .toEqual({ ok: true, required: null, failures: [] });
  });

  it("refuses a line change the exact commit does not authorize", () => {
    const result = releaseLineAuthorization({ stableLine: "0.4", previousLine: "0.3", commitMessage: advance });
    expect(result.ok).toBe(false);
    expect(result.required).toBe("Authorized-Release-Line: 0.4");
    expect(result.failures.join(" ")).toContain("Authorized-Release-Line: 0.4");
  });

  it("accepts a line change the exact commit authorizes", () => {
    const commitMessage = `${advance}\n\nAuthorized-Release-Line: 0.4\n`;
    expect(releaseLineAuthorization({ stableLine: "0.4", previousLine: "0.3", commitMessage }))
      .toEqual({ ok: true, required: "Authorized-Release-Line: 0.4", failures: [] });
  });

  it("does not accept an authorization for a different line", () => {
    const commitMessage = `${advance}\n\nAuthorized-Release-Line: 0.5\n`;
    expect(releaseLineAuthorization({ stableLine: "0.4", previousLine: "0.3", commitMessage }).ok).toBe(false);
  });

  it("still honours an approved job's environment authorization", () => {
    expect(releaseLineAuthorization({
      stableLine: "0.4", previousLine: "0.3", commitMessage: advance, humanAuthorized: true,
    })).toEqual({ ok: true, required: null, failures: [] });
  });
});
