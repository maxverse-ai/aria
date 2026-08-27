#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseVersion, validatePolicy, verifyTransition } from "./release-policy.mjs";
import { sha256File, validateManifest } from "./artifact.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedRepository = "maxverse-ai/aria";
const releaseWorkflowSuffix = "/.github/workflows/release.yml@refs/heads/main";

function command(name) {
  return process.platform === "win32" && ["corepack", "npm", "pnpm"].includes(name) ? `${name}.cmd` : name;
}

function run(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
  }).trim();
}

function compareVersions(leftInput, rightInput) {
  const left = parseVersion(leftInput);
  const right = parseVersion(rightInput);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (left.prerelease === right.prerelease) return 0;
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;
  const leftParts = left.prerelease.split(".");
  const rightParts = right.prerelease.split(".");
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    if (leftParts[index] === undefined) return -1;
    if (rightParts[index] === undefined) return 1;
    if (leftParts[index] === rightParts[index]) continue;
    const leftNumeric = /^\d+$/.test(leftParts[index]);
    const rightNumeric = /^\d+$/.test(rightParts[index]);
    if (leftNumeric && rightNumeric) return Number(leftParts[index]) - Number(rightParts[index]);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftParts[index].localeCompare(rightParts[index]);
  }
  return 0;
}

export function normalizeVersions(values) {
  return [...new Set(values.map((value) => parseVersion(String(value)).raw))].sort(compareVersions);
}

export function selectReleasePlan({ packageVersion, policy, taggedVersions = [], publishedVersions = [] }) {
  validatePolicy(policy);
  const tags = normalizeVersions(taggedVersions);
  const published = normalizeVersions(publishedVersions);
  const latestTag = tags.at(-1) ?? null;
  const latestPublished = published.at(-1) ?? null;

  if (latestTag && latestPublished && latestTag !== latestPublished) {
    throw new Error(`release state diverged: latest tag is ${latestTag}, registry is ${latestPublished}`);
  }
  if (latestTag && !latestPublished) {
    throw new Error(`release state diverged: tag v${latestTag} exists but the registry package is missing`);
  }
  if (!latestTag && latestPublished) {
    throw new Error(`release state diverged: registry has ${latestPublished} but its Git tag is missing`);
  }

  if (!latestPublished) {
    const parsed = parseVersion(packageVersion);
    const failures = [];
    if (policy.frozen) failures.push("release policy is frozen");
    if (`${parsed.major}.${parsed.minor}` !== policy.stableLine) {
      failures.push(`target ${packageVersion} is outside authorized release line ${policy.stableLine}`);
    }
    if (parsed.prerelease) failures.push("initial publication must be a stable version");
    return {
      ok: failures.length === 0,
      kind: "initial",
      from: null,
      target: packageVersion,
      needsVersionChange: false,
      humanRequired: true,
      failures,
    };
  }

  const publishedVersion = parseVersion(latestPublished);
  const target = packageVersion === latestPublished
    ? `${publishedVersion.major}.${publishedVersion.minor}.${publishedVersion.patch + 1}`
    : packageVersion;
  const transition = verifyTransition({ from: latestPublished, to: target, policy, humanAuthorized: false });
  return {
    ok: transition.ok,
    kind: "patch",
    from: latestPublished,
    target,
    needsVersionChange: packageVersion === latestPublished,
    humanRequired: false,
    failures: transition.failures,
  };
}

export function validatePublishContext(env) {
  const failures = [];
  if (env.GITHUB_ACTIONS !== "true") failures.push("publishing is restricted to GitHub Actions");
  if (env.GITHUB_REPOSITORY !== expectedRepository) failures.push(`publishing repository must be ${expectedRepository}`);
  if (env.GITHUB_REF !== "refs/heads/main") failures.push("publishing ref must be refs/heads/main");
  if (!String(env.GITHUB_WORKFLOW_REF ?? "").endsWith(releaseWorkflowSuffix)) {
    failures.push("publishing workflow must be .github/workflows/release.yml from main");
  }
  if (env.ARIA_RELEASE_PUBLISH !== "true") failures.push("ARIA_RELEASE_PUBLISH must be enabled by the protected publish job");
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    failures.push("GitHub OIDC token access is unavailable");
  }
  return { ok: failures.length === 0, failures };
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}

function taggedVersions() {
  return run(command("git"), ["tag", "--list", "v*"])
    .split("\n")
    .filter(Boolean)
    .map((tag) => tag.slice(1))
    .filter((version) => {
      try {
        parseVersion(version);
        return true;
      } catch {
        return false;
      }
    });
}

function publishedVersions(packageName) {
  try {
    const value = JSON.parse(run(command("npm"), ["view", packageName, "versions", "--json"]));
    return Array.isArray(value) ? value : value ? [value] : [];
  } catch (error) {
    const detail = `${error?.stderr ?? ""}${error?.stdout ?? ""}`;
    if (/E404|Not Found/i.test(detail)) return [];
    throw new Error("could not query npm registry versions");
  }
}

function releasePlan() {
  const packageJson = readJson("package.json");
  const policy = readJson(".release-policy.json");
  return {
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    ...selectReleasePlan({
      packageVersion: packageJson.version,
      policy,
      taggedVersions: taggedVersions(),
      publishedVersions: publishedVersions(packageJson.name),
    }),
  };
}

function assertCleanWorktree() {
  if (run(command("git"), ["status", "--porcelain", "--untracked-files=normal"])) {
    throw new Error("release operation requires a clean worktree");
  }
}

function assertExactMain() {
  const head = run(command("git"), ["rev-parse", "HEAD"]);
  const remoteMain = run(command("git"), ["rev-parse", "origin/main"]);
  if (head !== remoteMain) throw new Error("release commit must be the exact origin/main commit");
  return head;
}

function writeGitHubOutput(values) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value)}`);
  writeFileSync(path, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "a" });
}

function preparePatch() {
  assertCleanWorktree();
  const plan = releasePlan();
  if (!plan.ok) throw new Error(plan.failures.join("; "));
  if (plan.kind === "initial" || !plan.needsVersionChange) {
    writeGitHubOutput({ changed: false, target: plan.target, initial: plan.kind === "initial" });
    return plan;
  }
  const packageJsonPath = resolve(root, "package.json");
  const packageJson = readJson("package.json");
  packageJson.version = plan.target;
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  writeGitHubOutput({ changed: true, target: plan.target, initial: false });
  return plan;
}

function verifyReleaseArtifact() {
  assertCleanWorktree();
  const commit = assertExactMain();
  const plan = releasePlan();
  if (!plan.ok) throw new Error(plan.failures.join("; "));
  if (plan.needsVersionChange) throw new Error(`package.json must be advanced to ${plan.target} before publishing`);
  if (plan.target !== plan.packageVersion) throw new Error("release target does not match package.json");

  const manifest = validateManifest(readJson("artifacts/manifest.json"));
  if (manifest.kind !== "ci-candidate") throw new Error("release input must be a verified CI candidate");
  if (manifest.packageName !== plan.packageName || manifest.version !== plan.target) {
    throw new Error("artifact identity does not match the release target");
  }
  if (manifest.commit !== commit) throw new Error("artifact was not built from the exact origin/main commit");
  const tarballPath = resolve(root, "artifacts", manifest.tarball);
  if (sha256File(tarballPath) !== manifest.sha256) throw new Error("release artifact digest mismatch");
  if (taggedVersions().includes(plan.target)) throw new Error(`tag v${plan.target} already exists`);
  if (publishedVersions(plan.packageName).includes(plan.target)) throw new Error(`${plan.packageName}@${plan.target} is already published`);
  return { ...plan, commit, manifest: "artifacts/manifest.json", tarball: `artifacts/${basename(manifest.tarball)}`, sha256: manifest.sha256 };
}

function publishRelease() {
  const context = validatePublishContext(process.env);
  if (!context.ok) throw new Error(context.failures.join("; "));
  const result = verifyReleaseArtifact();
  if (result.kind === "initial") {
    throw new Error("npm trusted publishing requires an existing package; bootstrap the initial version interactively with 2FA, then configure the trusted publisher");
  }
  const npmVersion = run(command("npm"), ["--version"]);
  if (compareVersions(npmVersion, "11.5.1") < 0) throw new Error("trusted publishing requires npm 11.5.1 or newer");
  run(command("npm"), ["publish", result.tarball, "--access", "public", "--ignore-scripts"], { capture: false });
  if (!publishedVersions(result.packageName).includes(result.target)) {
    throw new Error("registry verification did not find the published version");
  }
  run(command("git"), ["tag", "-a", `v${result.target}`, result.commit, "-m", `Release v${result.target}`]);
  run(command("git"), ["push", "origin", `v${result.target}`], { capture: false });
  return { ...result, published: true, tag: `v${result.target}` };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const operation = process.argv[2] ?? "plan";
  if (operation === "plan") return print(releasePlan());
  if (operation === "prepare-patch") return print(preparePatch());
  if (operation === "verify") return print(verifyReleaseArtifact());
  if (operation === "publish") return print(publishRelease());
  if (operation === "publish-gate") {
    const result = validatePublishContext(process.env);
    if (!result.ok) throw new Error(result.failures.join("; "));
    return print(result);
  }
  throw new Error("release command must be plan, prepare-patch, verify, publish, or publish-gate");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
