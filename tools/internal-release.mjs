#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256File, validateManifest } from "./artifact.mjs";
import { parseVersion, validatePolicy } from "./release-policy.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedRepository = "maxverse-ai/aria";
const workflowSuffix = "/.github/workflows/internal-release.yml@refs/heads/main";

function run(executable, args) {
  return execFileSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}

export function internalTagForVersion(version) {
  const parsed = parseVersion(version);
  if (parsed.prerelease) throw new Error("internal snapshots require a stable package version");
  return `internal-v${parsed.raw}`;
}

export function validateInternalReleaseContext(env) {
  const failures = [];
  if (env.GITHUB_ACTIONS !== "true") failures.push("internal releases are restricted to GitHub Actions");
  if (env.GITHUB_REPOSITORY !== expectedRepository) {
    failures.push(`internal release repository must be ${expectedRepository}`);
  }
  if (env.GITHUB_REF !== "refs/heads/main") failures.push("internal releases must run from main");
  if (!String(env.GITHUB_WORKFLOW_REF ?? "").endsWith(workflowSuffix)) {
    failures.push("internal releases must use .github/workflows/internal-release.yml from main");
  }
  if (env.ARIA_INTERNAL_RELEASE !== "true") failures.push("ARIA_INTERNAL_RELEASE must be enabled");
  return { ok: failures.length === 0, failures };
}

export function createInternalReleasePlan({ packageJson, policy, manifest, commit, digest, notes }) {
  validatePolicy(policy);
  const version = parseVersion(packageJson.version);
  const failures = [];
  const stableLine = `${version.major}.${version.minor}`;

  if (policy.frozen) failures.push("release policy is frozen");
  if (version.prerelease) failures.push("internal snapshots require a stable package version");
  if (stableLine !== policy.stableLine) {
    failures.push(`package version ${version.raw} is outside authorized release line ${policy.stableLine}`);
  }
  if (manifest.kind !== "ci-candidate") failures.push("artifact must be a verified CI candidate");
  if (manifest.packageName !== packageJson.name) failures.push("artifact package name does not match package.json");
  if (manifest.version !== version.raw) failures.push("artifact version does not match package.json");
  if (manifest.commit !== commit) failures.push("artifact commit does not match the exact main commit");
  if (manifest.sha256 !== digest) failures.push("artifact digest does not match its manifest");
  if (!notes.trim()) failures.push("internal release notes are empty");
  if (!notes.includes(`# Aria Internal v${version.raw}`)) {
    failures.push("internal release notes do not match the package version");
  }

  return {
    ok: failures.length === 0,
    failures,
    packageName: packageJson.name,
    version: version.raw,
    tag: internalTagForVersion(version.raw),
    title: `Aria Internal v${version.raw}`,
    commit,
  };
}

export function createReleaseManifest({ packageJson, plan, manifest, digest, createdAt }) {
  if (!plan.ok) throw new Error("cannot create release metadata from an invalid internal release plan");
  const nodeRange = packageJson.engines?.node;
  if (typeof nodeRange !== "string" || !/^>=\d+\.\d+\.\d+$/.test(nodeRange)) {
    throw new Error("package engines.node must be a simple >=x.y.z range");
  }
  return {
    schemaVersion: 1,
    channel: "internal",
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
    throw new Error("internal release requires a clean worktree");
  }
}

function assertExactMain() {
  const head = run("git", ["rev-parse", "HEAD"]);
  const remoteMain = run("git", ["rev-parse", "origin/main"]);
  if (head !== remoteMain) throw new Error("internal release commit must be the exact origin/main commit");
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

function prepareInternalRelease() {
  assertCleanWorktree();
  const commit = assertExactMain();
  const packageJson = readJson("package.json");
  const policy = readJson(".release-policy.json");
  const manifest = validateManifest(readJson("artifacts/manifest.json"));
  const tarball = resolve(root, "artifacts", manifest.tarball);
  const notes = `docs/releases/v${packageJson.version}.md`;
  const notesContent = readFileSync(resolve(root, notes), "utf8");
  const digest = sha256File(tarball);
  const plan = createInternalReleasePlan({
    packageJson,
    policy,
    manifest,
    commit,
    digest,
    notes: notesContent,
  });
  if (!plan.ok) throw new Error(plan.failures.join("; "));
  if (run("git", ["tag", "--list", plan.tag])) throw new Error(`internal release tag ${plan.tag} already exists`);

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
  const result = {
    ...plan,
    tarball: `artifacts/${basename(tarball)}`,
    manifest: "artifacts/manifest.json",
    checksums: "artifacts/SHA256SUMS",
    releaseManifest: "artifacts/release.json",
    installer: "artifacts/aria-install.mjs",
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
    const result = validateInternalReleaseContext(process.env);
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (operation === "prepare") return print(prepareInternalRelease());
  throw new Error("internal release command must be context-gate or prepare");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`internal release error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
