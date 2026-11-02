import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readSession, saveSession, reconcileAssets, resumeSession } from "../../../tools/release-session.mjs";
import type { RemoteRelease, SessionAsset } from "../../../tools/release-session.mjs";
import { sha256File } from "../../../tools/artifact.mjs";
import { releaseStage } from "../../../tools/release.mjs";

function fixture() {
  const session = {
    schemaVersion: 1, repository: "maxverse-ai/aria", version: "0.4.6", tag: "v0.4.6",
    commit: "a".repeat(40), node: process.version, pnpm: "12.0.0", platform: process.platform, arch: process.arch,
    notesSha256: "b".repeat(64), stage: "prepared",
    assets: ["aria-install.mjs", "aria-worker-0.4.6.tgz", "aria-worker-manifest.json", "aria-worker-SHA256SUMS", "manifest.json", "maxverse-ai-aria-0.4.6.tgz", "release.json", "SHA256SUMS"].map((name) => ({ name, size: 1, sha256: "c".repeat(64) })),
  };
  let release: RemoteRelease | undefined;
  const operations = {
    inspect: vi.fn(() => release),
    create: vi.fn(() => { release = { id: 12, tag_name: session.tag, target_commitish: session.commit, draft: true, prerelease: false, assets: [] }; }),
    save: vi.fn(),
    upload: vi.fn((asset: SessionAsset) => { release!.assets.push({ ...asset, digest: `sha256:${asset.sha256}` }); }),
    verify: vi.fn(), checkMain: vi.fn(), verifyTag: vi.fn(),
    publish: vi.fn(() => { release!.draft = false; release!.immutable = true; }),
  };
  return { session, operations, getRelease: () => release };
}

describe("release recovery", () => {
  it("resumes partial uploads without replacing uploaded assets", () => {
    const { session, operations } = fixture();
    const upload = operations.upload.getMockImplementation()!;
    operations.upload.mockImplementationOnce((asset) => { upload(asset); throw new Error("network timeout"); });
    expect(() => resumeSession(session, operations)).toThrow("network timeout");
    expect(operations.publish).not.toHaveBeenCalled();
    resumeSession(session, operations);
    expect(operations.create).toHaveBeenCalledOnce();
    expect(operations.upload).toHaveBeenCalledTimes(8);
    expect(session).toMatchObject({ stage: "complete", releaseId: 12 });
  });

  it("reconciles a creation timeout before attempting another creation", () => {
    const { session, operations } = fixture();
    const create = operations.create.getMockImplementation()!;
    operations.create.mockImplementationOnce(() => { create(); throw new Error("timeout"); });
    expect(() => resumeSession(session, operations)).toThrow("timeout");
    resumeSession(session, operations);
    expect(operations.create).toHaveBeenCalledOnce();
  });

  it("verifies an already published release after a publication timeout", () => {
    const { session, operations } = fixture();
    const publish = operations.publish.getMockImplementation()!;
    operations.publish.mockImplementationOnce(() => { publish(); throw new Error("timeout"); });
    expect(() => resumeSession(session, operations)).toThrow("timeout");
    resumeSession(session, operations);
    expect(operations.publish).toHaveBeenCalledOnce();
    expect(operations.verifyTag).toHaveBeenCalledOnce();
  });

  it("stops on changed main or failed downloaded checksums", () => {
    for (const stage of ["checkMain", "verify"] as const) {
      const { session, operations } = fixture();
      operations[stage].mockImplementation(() => { throw new Error(stage); });
      expect(() => resumeSession(session, operations)).toThrow(stage);
      expect(operations.publish).not.toHaveBeenCalled();
    }
  });

  it("retains a draft when main changes after upload", () => {
    const { session, operations } = fixture();
    operations.checkMain.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { throw new Error("main changed"); });
    expect(() => resumeSession(session, operations)).toThrow("main changed");
    expect(operations.upload).toHaveBeenCalledTimes(8);
    expect(operations.publish).not.toHaveBeenCalled();
  });

  it("does not publish a draft changed after download verification", () => {
    const { session, operations, getRelease } = fixture();
    operations.verify.mockImplementationOnce(() => { getRelease()!.assets.pop(); });
    expect(() => resumeSession(session, operations)).toThrow("draft changed");
    expect(operations.publish).not.toHaveBeenCalled();
  });

  it("retries final tag verification without publishing again", () => {
    const { session, operations } = fixture();
    operations.verifyTag.mockImplementationOnce(() => { throw new Error("fetch failed"); });
    expect(() => resumeSession(session, operations)).toThrow("fetch failed");
    resumeSession(session, operations);
    expect(operations.publish).toHaveBeenCalledOnce();
    expect(operations.verifyTag).toHaveBeenCalledTimes(2);
  });

  it("rejects conflicting identity, assets and nonimmutable publication", () => {
    const { session, operations, getRelease } = fixture();
    resumeSession(session, operations);
    const release = getRelease()!;
    for (const changed of [
      { ...release, target_commitish: "wrong" },
      { ...release, immutable: false },
      { ...release, assets: release.assets.slice(1) },
      { ...release, assets: [{ ...release.assets[0]!, digest: "wrong" }, ...release.assets.slice(1)] },
      { ...release, assets: [...release.assets, release.assets[0]!] },
    ]) expect(() => reconcileAssets(session, changed)).toThrow();
  });

  it("validates persisted toolchain identity and every local asset before recovery", () => {
    const directory = mkdtempSync(join(tmpdir(), "aria-session-"));
    try {
      mkdirSync(join(directory, "artifacts"));
      const { session } = fixture();
      for (const asset of session.assets) {
        const path = join(directory, "artifacts", asset.name);
        writeFileSync(path, "x");
        asset.sha256 = sha256File(path);
      }
      const path = join(directory, "session.json");
      saveSession(path, session);
      expect(readSession(path, session, directory)).toEqual(session);
      expect(() => readSession(path, { ...session, node: "different" }, directory)).toThrow(/toolchain/);
      writeFileSync(join(directory, "artifacts", session.assets[0]!.name), "changed");
      expect(() => readSession(path, session, directory)).toThrow(/asset changed/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("reports stage failure and duration without hiding the error", () => {
    const report = vi.fn();
    expect(() => releaseStage("gate", () => { throw new Error("failed gate"); }, report)).toThrow("failed gate");
    expect(report.mock.calls[1]![0]).toMatchObject({ stage: "gate", status: "failed", durationMs: expect.any(Number) });
  });
});
