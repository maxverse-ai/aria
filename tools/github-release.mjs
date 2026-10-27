#!/usr/bin/env node

import crossSpawn from "cross-spawn";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256File, validateManifest, verifyStandaloneNodeAsset } from "./artifact.mjs";
import { validateWorkerManifest } from "./worker-artifact.mjs";
import {
  latestReleaseTagVersion,
  parseVersion,
  releaseLineAuthorization,
  validatePolicy,
  versionLine,
} from "./release-policy.mjs";

// The rule lives with the rest of the release policy so `check` and the release
// path cannot drift apart; re-exported here because the release owns the refusal.
export { releaseLineAuthorization };

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedRepository = "maxverse-ai/aria";

function run(executable, args) {
  const result = crossSpawn.sync(executable, args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${executable} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}

export function tagForVersion(version) {
  const parsed = parseVersion(version);
  if (parsed.prerelease) throw new Error("releases require a stable package version");
  return `v${parsed.raw}`;
}

export function validateReleaseContext(env) {
  const failures = [];
  if (env.GITHUB_ACTIONS === "true" || (env.CI && env.CI !== "false")) {
    failures.push("releases must run locally on the host, not in CI/CD");
  }
  return { ok: failures.length === 0, failures };
}

export function createGitHubReleasePlan({ packageJson, policy, manifest, commit, digest, notes }) {
  validatePolicy(policy);
  const version = parseVersion(packageJson.version);
  const failures = [];
  const stableLine = `${version.major}.${version.minor}`;

  if (policy.frozen) failures.push("release policy is frozen");
  if (version.prerelease) failures.push("releases require a stable package version");
  if (stableLine !== policy.stableLine) {
    failures.push(`package version ${version.raw} is outside authorized release line ${policy.stableLine}`);
  }
  if (manifest.kind !== "ci-candidate") failures.push("artifact must be a verified CI candidate");
  if (manifest.packageName !== packageJson.name) failures.push("artifact package name does not match package.json");
  if (manifest.version !== version.raw) failures.push("artifact version does not match package.json");
  if (manifest.commit !== commit) failures.push("artifact commit does not match the exact main commit");
  if (manifest.sha256 !== digest) failures.push("artifact digest does not match its manifest");
  if (!notes.trim()) failures.push("GitHub release notes are empty");
  if (!notes.includes(`# Aria v${version.raw}`)) {
    failures.push("GitHub release notes do not match the package version");
  }

  return {
    ok: failures.length === 0,
    failures,
    packageName: packageJson.name,
    version: version.raw,
    tag: tagForVersion(version.raw),
    title: `Aria v${version.raw}`,
    commit,
  };
}

export function createReleaseManifest({ packageJson, plan, manifest, digest, createdAt }) {
  if (!plan.ok) throw new Error("cannot create release metadata from an invalid GitHub release plan");
  const nodeRange = packageJson.engines?.node;
  if (typeof nodeRange !== "string" || !/^>=\d+\.\d+\.\d+$/.test(nodeRange)) {
    throw new Error("package engines.node must be a simple >=x.y.z range");
  }
  return {
    schemaVersion: 1,
    channel: "stable",
    repository: expectedRepository,
    tag: plan.tag,
    version: plan.version,
    commit: plan.commit,
    packageName: packageJson.name,
    artifactManifest: "manifest.json",
    tarball: basename(manifest.tarball),
    checksums: "SHA256SUMS",
    sha256: digest,
    nodeRange,
    stateSchemaVersion: 1,
    minRollbackVersion: null,
    createdAt,
  };
}

function assertCleanWorktree() {
  if (run("git", ["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("GitHub release requires a clean worktree");
  }
}

function assertExactMain() {
  const head = run("git", ["rev-parse", "HEAD"]);
  const remoteMain = run("git", ["rev-parse", "origin/main"]);
  if (head !== remoteMain) throw new Error("GitHub release commit must be the exact origin/main commit");
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head) {
    throw new Error("workflow commit does not match the checked-out main commit");
  }
  return head;
}

function writeGitHubOutput(values) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value)}`);
  writeFileSync(path, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "a" });
}

function prepareGitHubRelease() {
  const context = validateReleaseContext(process.env);
  if (!context.ok) throw new Error(context.failures.join("; "));
  assertCleanWorktree();
  const commit = assertExactMain();
  const packageJson = readJson("package.json");
  const policy = readJson(".release-policy.json");
  const published = latestReleaseTagVersion();
  const authorization = releaseLineAuthorization({
    stableLine: policy.stableLine,
    previousLine: published ? versionLine(published) : null,
    commitMessage: run("git", ["log", "-1", "--format=%B", commit]),
    humanAuthorized: process.env.ARIA_RELEASE_HUMAN_AUTHORIZED === "true",
  });
  if (!authorization.ok) throw new Error(authorization.failures.join("; "));
  const manifest = validateManifest(readJson("artifacts/manifest.json"));
  const tarball = resolve(root, "artifacts", manifest.tarball);
  const notes = `docs/releases/v${packageJson.version}.md`;
  const notesContent = readFileSync(resolve(root, notes), "utf8");
  const digest = sha256File(tarball);
  const plan = createGitHubReleasePlan({
    packageJson,
    policy,
    manifest,
    commit,
    digest,
    notes: notesContent,
  });
  if (!plan.ok) throw new Error(plan.failures.join("; "));
  if (run("git", ["tag", "--list", plan.tag])) throw new Error(`GitHub release tag ${plan.tag} already exists`);

  const checksumPath = resolve(root, "artifacts", "SHA256SUMS");
  writeFileSync(checksumPath, `${digest}  ${basename(tarball)}\n`, "utf8");
  const releaseManifestPath = resolve(root, "artifacts", "release.json");
  const releaseManifest = createReleaseManifest({
    packageJson,
    plan,
    manifest,
    digest,
    createdAt: new Date().toISOString(),
  });
  writeFileSync(releaseManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");
  const installerPath = resolve(root, "artifacts", "aria-install.mjs");
  copyFileSync(resolve(root, "dist", "installer.js"), installerPath);
  verifyStandaloneNodeAsset(installerPath);
  const workerManifestPath = resolve(root, "artifacts", "aria-worker-manifest.json");
  const workerChecksumsPath = resolve(root, "artifacts", "aria-worker-SHA256SUMS");
  const workerManifest = validateWorkerManifest(JSON.parse(readFileSync(workerManifestPath, "utf8")), {
    version: packageJson.version,
    commit,
  });
  const workerTarball = resolve(root, "artifacts", workerManifest.tarball);
  if (sha256File(workerTarball) !== workerManifest.sha256) {
    throw new Error("worker release asset digest does not match its manifest");
  }
  const workerChecksums = readFileSync(workerChecksumsPath, "utf8");
  if (workerChecksums !== `${workerManifest.sha256}  ${workerManifest.tarball}\n`) {
    throw new Error("worker release checksum file does not match its manifest");
  }
  const result = {
    ...plan,
    tarball: `artifacts/${basename(tarball)}`,
    manifest: "artifacts/manifest.json",
    checksums: "artifacts/SHA256SUMS",
    releaseManifest: "artifacts/release.json",
    installer: "artifacts/aria-install.mjs",
    worker: `artifacts/${workerManifest.tarball}`,
    workerManifest: "artifacts/aria-worker-manifest.json",
    workerChecksums: "artifacts/aria-worker-SHA256SUMS",
    notes,
    sha256: digest,
  };
  writeGitHubOutput(result);
  return result;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const operation = process.argv[2];
  if (operation === "context-gate") {
    const result = validateReleaseContext(process.env);
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (operation === "prepare") return print(prepareGitHubRelease());
  throw new Error("GitHub release command must be context-gate or prepare");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`GitHub release error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
