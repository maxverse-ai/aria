#!/usr/bin/env node

import crossSpawn from "cross-spawn";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseVersion, validatePolicy, verifyTransition } from "./release-policy.mjs";
import { sha256File, validateManifest } from "./artifact.mjs";
import { validateWorkerManifest } from "./worker-artifact.mjs";
import { validateReleaseContext } from "./github-release.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedRepository = "maxverse-ai/aria";

function command(name) {
  return process.platform === "win32" && ["corepack", "npm", "pnpm"].includes(name) ? `${name}.cmd` : name;
}

function run(executable, args, options = {}) {
  const result = crossSpawn.sync(executable, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${executable} failed (${result.status}): ${result.stderr ?? ""}`);
  return result.stdout?.trim() ?? "";
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
  return validateReleaseContext(env);
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

// The public distribution registry is GitHub Releases: a published `v*` tag
// owns a non-draft, non-prerelease release in the repository.
function publishedVersions() {
  let value;
  try {
    value = run(command("gh"), ["api", `repos/${expectedRepository}/releases?per_page=100`]);
  } catch {
    throw new Error("could not query GitHub releases (gh authentication required)");
  }
  let releases;
  try {
    releases = JSON.parse(value);
  } catch {
    throw new Error("GitHub releases API returned invalid JSON");
  }
  if (!Array.isArray(releases)) throw new Error("GitHub releases API returned a non-array response");
  return releases
    .filter((release) => release.draft === false && release.prerelease === false && typeof release.tag_name === "string")
    .map((release) => release.tag_name.replace(/^v/, ""))
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version));
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
      publishedVersions: publishedVersions(),
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
  if (publishedVersions().includes(plan.target)) throw new Error(`v${plan.target} is already published`);
  const workerManifest = validateWorkerManifest(readJson("artifacts/aria-worker-manifest.json"), {
    version: plan.target,
    commit,
  });
  const workerTarball = resolve(root, "artifacts", workerManifest.tarball);
  if (sha256File(workerTarball) !== workerManifest.sha256) {
    throw new Error("worker release asset digest does not match its manifest");
  }
  return {
    ...plan,
    commit,
    manifest: "artifacts/manifest.json",
    tarball: `artifacts/${basename(manifest.tarball)}`,
    sha256: manifest.sha256,
    worker: `artifacts/${workerManifest.tarball}`,
  };
}

// Release bodies render on github.com/<owner>/<repo>/releases, where relative
// links resolve against the tag root rather than the notes directory. Rewrite
// them to absolute blob URLs so locale pointers and doc links keep working.
export function renderReleaseNotes(notesPath, tag) {
  const notesDir = dirname(notesPath);
  return readFileSync(resolve(root, notesPath), "utf8").replace(
    /\]\((?!https?:|#|mailto:)([^)\s]+)\)/g,
    (_match, target) => {
      const [filePath, suffix] = target.split(/(?=[#?])/);
      const resolved = posix.normalize(posix.join(notesDir, filePath));
      return `](https://github.com/${expectedRepository}/blob/${tag}/${resolved}${suffix ?? ""})`;
    },
  );
}

export function validateOrigin(origin) {
  return ["https://github.com/maxverse-ai/aria.git", "https://github.com/maxverse-ai/aria", "git@github.com:maxverse-ai/aria.git", "ssh://git@github.com/maxverse-ai/aria.git"].includes(origin);
}

export function withReleaseLock(commonDirectory, operation) {
  const lock = resolve(commonDirectory, "aria-local-release.lock");
  try { mkdirSync(lock); } catch (error) {
    if (error.code === "EEXIST") throw new Error("another local release holds the repository lock; inspect before removing a stale lock");
    throw error;
  }
  try {
    writeFileSync(resolve(lock, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return operation();
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

function refreshMain() {
  run("git", ["fetch", "origin", "main:refs/remotes/origin/main", "--tags"]);
  return assertExactMain();
}

function publishRelease() {
  const context = validatePublishContext(process.env);
  if (!context.ok) throw new Error(context.failures.join("; "));
  if (!validateOrigin(run("git", ["remote", "get-url", "origin"]))) throw new Error("origin must be the canonical maxverse-ai/aria repository");
  run("gh", ["auth", "status"], { capture: false });
  const repository = JSON.parse(run("gh", ["api", `repos/${expectedRepository}`]));
  if (repository.full_name !== expectedRepository || !repository.permissions?.push) throw new Error("authenticated gh user needs push permission to the canonical repository");
  const immutable = JSON.parse(run("gh", ["api", `repos/${expectedRepository}/immutable-releases`]));
  if (immutable.enabled !== true) throw new Error("repository release immutability must be enabled before publication");
  const commonDirectory = resolve(root, run("git", ["rev-parse", "--git-common-dir"]));
  return withReleaseLock(commonDirectory, () => {
    assertCleanWorktree();
    const commit = refreshMain();
    const plan = releasePlan();
    if (!plan.ok || plan.needsVersionChange) throw new Error(plan.failures.join("; ") || "merge the prepared version before publishing");
    run(command("pnpm"), ["ci:local"], { capture: false });
    run(command("pnpm"), ["artifact:build"], { capture: false });
    run(command("pnpm"), ["artifact:verify"], { capture: false });
    run(process.execPath, ["tools/github-release.mjs", "prepare"], { capture: false });
    assertCleanWorktree();
    if (refreshMain() !== commit) throw new Error("main changed during local release validation");
    return publishVerifiedRelease();
  });
}

function publishVerifiedRelease() {
  const result = verifyReleaseArtifact();
  const tag = `v${result.target}`;
  const notesPath = `docs/releases/v${result.target}.md`;
  if (!existsSync(resolve(root, notesPath))) throw new Error(`release notes ${notesPath} are missing`);
  const renderedNotesPath = "artifacts/release-notes.md";
  writeFileSync(resolve(root, renderedNotesPath), renderReleaseNotes(notesPath, tag), "utf8");
  const assets = [
    result.tarball,
    "artifacts/manifest.json",
    "artifacts/SHA256SUMS",
    "artifacts/release.json",
    "artifacts/aria-install.mjs",
    result.worker,
    "artifacts/aria-worker-manifest.json",
    "artifacts/aria-worker-SHA256SUMS",
  ];
  for (const asset of assets) {
    if (!existsSync(resolve(root, asset))) {
      throw new Error(`release asset ${asset} is missing; run github-release:prepare first`);
    }
  }
  run(command("gh"), [
    "release", "create", tag, ...assets,
    "--repo", expectedRepository,
    "--target", result.commit,
    "--title", `Aria ${tag}`,
    "--notes-file", renderedNotesPath,
    "--draft",
  ], { capture: false });
  const downloaded = mkdtempSync(resolve(tmpdir(), "aria-release-download-"));
  try {
    run("gh", ["release", "download", tag, "--repo", expectedRepository, "--dir", downloaded]);
    for (const asset of assets) {
      if (sha256File(resolve(downloaded, basename(asset))) !== sha256File(resolve(root, asset))) {
        throw new Error(`uploaded release asset does not match local bytes: ${basename(asset)}`);
      }
    }
  } finally { rmSync(downloaded, { recursive: true, force: true }); }
  if (refreshMain() !== result.commit) throw new Error("main changed before publication; draft retained for inspection");
  const existingTag = run("git", ["tag", "--list", tag]);
  if (existingTag && run("git", ["rev-parse", `${tag}^{commit}`]) !== result.commit) {
    throw new Error("release tag appeared with a different commit; draft retained for inspection");
  }
  const draft = JSON.parse(run("gh", ["api", `repos/${expectedRepository}/releases/tags/${tag}`]));
  if (draft.draft !== true || draft.target_commitish !== result.commit) {
    throw new Error("draft release target no longer matches the tested commit");
  }
  const expectedAssets = assets.map((asset) => basename(asset)).sort();
  const actualAssets = (draft.assets ?? []).map((asset) => asset.name).sort();
  if (actualAssets.length !== expectedAssets.length || actualAssets.some((asset, index) => asset !== expectedAssets[index])) {
    throw new Error("draft release assets no longer match the verified contract");
  }
  run("gh", ["release", "edit", tag, "--repo", expectedRepository, "--draft=false", "--latest"], { capture: false });
  const published = JSON.parse(run("gh", ["api", `repos/${expectedRepository}/releases/tags/${tag}`]));
  if (published.draft || published.prerelease || published.immutable !== true || published.assets.length !== assets.length) {
    throw new Error("published release is not immutable, stable and complete; do not consume it");
  }
  run("git", ["fetch", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
  if (run("git", ["rev-parse", `${tag}^{commit}`]) !== result.commit) throw new Error("published tag does not match the tested commit");
  return { ...result, published: true, tag };
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
    throw new Error("npm publication is unsupported; use pnpm release:publish for host-local GitHub Releases");
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
