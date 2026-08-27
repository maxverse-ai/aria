import { describe, expect, it } from "vitest";

import {
  classifyTransition,
  nextVersion,
  validatePolicy,
  verifyTransition,
} from "../../../tools/release-policy.mjs";

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

describe("release policy", () => {
  it("allows exactly the next patch on the authorized release line", () => {
    expect(verifyTransition({ from: "0.1.1", to: "0.1.2", policy })).toMatchObject({
      ok: true,
      level: "patch",
    });
    expect(verifyTransition({ from: "0.1.1", to: "0.1.3", policy }).ok).toBe(false);
    expect(verifyTransition({ from: "0.1.1-rc.1", to: "0.1.2", policy }).ok).toBe(false);
  });

  it("rejects targets outside the authorized line", () => {
    const result = verifyTransition({ from: "0.1.1", to: "0.2.0", policy, humanAuthorized: true });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("target 0.2.0 is outside authorized release line 0.1");
  });

  it("requires durable human authorization for minor, major, and stable promotion", () => {
    const minorPolicy = { ...policy, stableLine: "0.2" };
    expect(verifyTransition({ from: "0.1.9", to: "0.2.0", policy: minorPolicy }).ok).toBe(false);
    expect(verifyTransition({ from: "0.1.9", to: "0.2.0", policy: minorPolicy, humanAuthorized: true }).ok).toBe(true);

    const majorPolicy = { ...policy, stableLine: "1.0" };
    expect(verifyTransition({ from: "0.9.9", to: "1.0.0", policy: majorPolicy }).ok).toBe(false);
    expect(verifyTransition({ from: "0.9.9", to: "1.0.0", policy: majorPolicy, humanAuthorized: true }).ok).toBe(true);

    expect(verifyTransition({ from: "0.1.2-rc.1", to: "0.1.2", policy }).ok).toBe(false);
    expect(verifyTransition({ from: "0.1.2-rc.1", to: "0.1.2", policy, humanAuthorized: true }).ok).toBe(true);
  });

  it("blocks all releases while frozen", () => {
    const result = verifyTransition({ from: "0.1.1", to: "0.1.2", policy: { ...policy, frozen: true } });
    expect(result.ok).toBe(false);
    expect(result.failures).toContain("release policy is frozen");
  });

  it("classifies transitions and calculates candidate versions", () => {
    expect(classifyTransition("0.1.1", "0.1.2")).toBe("patch");
    expect(classifyTransition("0.1.2-rc.1", "0.1.2")).toBe("stable-promotion");
    expect(nextVersion("0.1.1", "patch")).toBe("0.1.2");
    expect(nextVersion("0.1.1", "minor")).toBe("0.2.0");
    expect(nextVersion("0.1.1", "major")).toBe("1.0.0");
  });

  it("only advances prereleases monotonically", () => {
    expect(verifyTransition({ from: "0.1.2-alpha.1", to: "0.1.2-alpha.2", policy }).ok).toBe(true);
    expect(verifyTransition({ from: "0.1.2-alpha.2", to: "0.1.2-beta.1", policy }).ok).toBe(true);
    expect(verifyTransition({ from: "0.1.2-beta.1", to: "0.1.2-rc.1", policy }).ok).toBe(true);
    expect(verifyTransition({ from: "0.1.2-rc.2", to: "0.1.2-rc.1", policy }).ok).toBe(false);
    expect(verifyTransition({ from: "0.1.2", to: "0.1.2-rc.1", policy }).ok).toBe(false);
    expect(verifyTransition({ from: "0.1.2-alpha.0", to: "0.1.2-alpha.1", policy }).ok).toBe(false);
  });

  it("validates machine-readable policy fields", () => {
    expect(validatePolicy(policy)).toBe(policy);
    expect(() => validatePolicy({ ...policy, batchWindowMinutes: -1 })).toThrow(/batchWindowMinutes/);
    expect(() => validatePolicy({ ...policy, stableLine: "0.1.0" })).toThrow(/stableLine/);
  });
});
