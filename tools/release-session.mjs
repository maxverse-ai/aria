import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { sha256File } from "./artifact.mjs";

export function saveSession(path, session) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

export function readSession(path, expected, root) {
  const session = JSON.parse(readFileSync(path, "utf8"));
  if (session.schemaVersion !== 1 || session.repository !== expected.repository
      || session.commit !== expected.commit || session.version !== expected.version
      || session.node !== expected.node || session.pnpm !== expected.pnpm
      || session.platform !== expected.platform || session.arch !== expected.arch
      || session.tag !== `v${expected.version}` || !/^[a-f0-9]{64}$/.test(session.notesSha256)
      || !["prepared", "draft", "published", "download-verified", "complete"].includes(session.stage)) {
    throw new Error("release session identity or toolchain changed; inspect before restarting");
  }
  if (!Array.isArray(session.assets) || session.assets.length !== 8
      || new Set(session.assets.map((asset) => asset.name)).size !== 8) {
    throw new Error("release session must contain eight unique assets");
  }
  const names = session.assets.map((asset) => asset.name).sort();
  const required = ["aria-install.mjs", `aria-worker-${session.version}.tgz`, "aria-worker-manifest.json", "aria-worker-SHA256SUMS", "manifest.json", `maxverse-ai-aria-${session.version}.tgz`, "release.json", "SHA256SUMS"].sort();
  if (names.some((name, index) => name !== required[index])) throw new Error("release session asset contract changed");
  for (const asset of session.assets) {
    if (typeof asset.name !== "string" || basename(asset.name) !== asset.name
        || !Number.isSafeInteger(asset.size) || asset.size < 0 || !/^[a-f0-9]{64}$/.test(asset.sha256)
        || sha256File(resolve(root, "artifacts", asset.name)) !== asset.sha256) {
      throw new Error("release session asset changed; inspect before restarting");
    }
  }
  return session;
}

export function reconcileAssets(session, release) {
  if (release.tag_name !== session.tag || release.target_commitish !== session.commit
      || release.prerelease !== false || (!release.draft && release.immutable !== true)) {
    throw new Error("existing release identity or publication state does not match the session");
  }
  const expected = new Map(session.assets.map((asset) => [asset.name, asset]));
  const seen = new Set();
  for (const asset of release.assets ?? []) {
    const local = expected.get(asset.name);
    if (!local || seen.has(asset.name) || asset.size !== local.size
        || (asset.digest && asset.digest !== `sha256:${local.sha256}`)) {
      throw new Error(`existing release asset conflicts with session: ${asset.name}`);
    }
    seen.add(asset.name);
  }
  const missing = session.assets.filter((asset) => !seen.has(asset.name));
  if (!release.draft && missing.length) throw new Error("published release is incomplete");
  return missing;
}

export function resumeSession(session, operations) {
  let release = operations.inspect();
  if (!release) {
    operations.checkMain();
    operations.create();
    release = operations.inspect();
    if (!release) throw new Error("release creation could not be confirmed; resume after inspecting GitHub");
  }
  const missing = reconcileAssets(session, release);
  session.releaseId = release.id;
  session.stage = release.draft ? "draft" : "published";
  operations.save();
  if (release.draft) {
    for (const asset of missing) operations.upload(asset);
  }
  release = operations.inspect();
  if (!release || reconcileAssets(session, release).length) throw new Error("release assets are incomplete");
  operations.verify(release);
  session.stage = "download-verified";
  operations.save();
  if (release.draft) {
    operations.checkMain();
    const latest = operations.inspect();
    if (!latest || !latest.draft || latest.id !== release.id || reconcileAssets(session, latest).length) {
      throw new Error("draft changed before publication");
    }
    operations.verify(latest);
    operations.checkMain();
    operations.publish();
  }
  release = operations.inspect();
  if (!release || release.draft || reconcileAssets(session, release).length) {
    throw new Error("publication could not be confirmed; resume to verify the remote state");
  }
  operations.verifyTag();
  session.stage = "complete";
  operations.save();
  return release;
}
