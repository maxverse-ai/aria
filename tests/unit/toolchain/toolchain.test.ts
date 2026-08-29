import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  sha256File,
  validateManifest,
  validatePackageInventory,
  validatePackageName,
  verifyStandaloneNodeAsset,
} from "../../../tools/artifact.mjs";
import { compareNumericVersions, evaluateToolchain, parseNumericVersion } from "../../../tools/infra-doctor.mjs";

const requiredFiles = [
  "LICENSE",
  "README.md",
  "README.zh.md",
  "bin/aria.mjs",
  "dist/cli.js",
  "dist/installer.js",
  "dist/updater.js",
  "dist/index.d.ts",
  "dist/index.js",
  "package.json",
];

describe("toolchain doctor", () => {
  it("parses and compares numeric runtime versions", () => {
    expect(parseNumericVersion("v22.22.3")).toEqual([22, 22, 3]);
    expect(compareNumericVersions([20, 12, 0], [20, 12, 0])).toBe(0);
    expect(compareNumericVersions([22, 0, 0], [20, 12, 0])).toBe(1);
    expect(() => parseNumericVersion("latest")).toThrow(/invalid tool version/);
  });

  it("fails hard requirements but only warns on a non-preferred supported Node", () => {
    const supported = evaluateToolchain({
      nodeVersion: "v20.12.0",
      minimumNode: "20.12.0",
      preferredNode: "22.22.3",
      pnpmVersion: "10.33.0",
      expectedPnpm: "10.33.0",
      gitAvailable: true,
      tarAvailable: true,
      lockfileExists: true,
    });
    expect(supported.ok).toBe(true);
    expect(supported.checks.find((check) => check.id === "node-preferred")?.status).toBe("warn");

    const unsupported = evaluateToolchain({
      nodeVersion: "v18.20.0",
      minimumNode: "20.12.0",
      preferredNode: "22.22.3",
      pnpmVersion: "9.0.0",
      expectedPnpm: "10.33.0",
      gitAvailable: false,
      tarAvailable: false,
      lockfileExists: false,
    });
    expect(unsupported.ok).toBe(false);
  });
});

describe("candidate artifact metadata", () => {
  it("requires the runtime package inventory", () => {
    expect(validatePackageInventory(requiredFiles)).toEqual([...requiredFiles].sort());
    expect(() => validatePackageInventory(requiredFiles.filter((file) => file !== "dist/cli.js"))).toThrow(/dist\/cli\.js/);
  });

  it("accepts npm package identities without allowing path traversal", () => {
    expect(validatePackageName("@maxverse-ai/aria")).toBe("@maxverse-ai/aria");
    expect(validatePackageName("aria")).toBe("aria");
    expect(() => validatePackageName("../../aria")).toThrow(/package name/);
    expect(() => validatePackageName("@maxverse-ai/../aria")).toThrow(/package name/);
  });

  it("validates manifest identity and hashes files", () => {
    const directory = mkdtempSync(join(tmpdir(), "aria-artifact-unit-"));
    const file = join(directory, "artifact.tgz");
    writeFileSync(file, "aria", "utf8");
    expect(sha256File(file)).toBe("48803cad0f3dcf6436b26680f2c253e8e17da7005ab6ec25edff725183fc5d75");

    const manifest = {
      schemaVersion: 1 as const,
      kind: "ci-candidate" as const,
      packageName: "@maxverse-ai/aria",
      version: "0.1.1",
      commit: "a".repeat(40),
      builtAt: "2026-08-26T00:00:00.000Z",
      nodeVersion: "v22.22.3",
      pnpmVersion: "10.33.0",
      platform: "linux",
      arch: "x64",
      tarball: "aria.tgz",
      sha256: "b".repeat(64),
      unpackedSize: 123,
      files: requiredFiles,
    };
    expect(validateManifest(manifest)).toBe(manifest);
    expect(() => validateManifest({ ...manifest, tarball: "../aria.tgz" })).toThrow(/basename/);
    rmSync(directory, { recursive: true, force: true });
  });

  it("executes release entrypoints with no repository dependency tree", () => {
    const directory = mkdtempSync(join(tmpdir(), "aria-standalone-unit-"));
    const standalone = join(directory, "standalone.mjs");
    const externalized = join(directory, "externalized.mjs");
    writeFileSync(standalone, 'console.log("Usage: aria")\n', "utf8");
    writeFileSync(externalized, 'import "missing-aria-release-dependency";\n', "utf8");

    expect(verifyStandaloneNodeAsset(standalone)).toContain("Usage: aria");
    expect(() => verifyStandaloneNodeAsset(externalized)).toThrow(/cannot run without repository dependencies/);
    rmSync(directory, { recursive: true, force: true });
  });
});
