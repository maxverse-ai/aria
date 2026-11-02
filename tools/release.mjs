#!/usr/bin/env node

import crossSpawn from "cross-spawn";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync, statSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseVersion, validatePolicy, verifyTransition } from "./release-policy.mjs";
import { sha256File, validateManifest } from "./artifact.mjs";
import { validateWorkerManifest } from "./worker-artifact.mjs";
import { validateReleaseContext } from "./github-release.mjs";
import { saveSession, readSession, resumeSession } from "./release-session.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expectedRepository = "maxverse-ai/aria";
let stageLog;

export function releaseStage(name, operation, report = (event) => {
  const line = JSON.stringify(event);
  process.stderr.write(`${line}\n`);
  if (stageLog) appendFileSync(stageLog, `${line}\n`);
}) {
  const started = Date.now();
  report({ stage: name, status: "started", at: new Date(started).toISOString() });
  try {
    const result = operation();
    report({ stage: name, status: "passed", durationMs: Date.now() - started });
    return result;
  } catch (error) {
    report({ stage: name, status: "failed", durationMs: Date.now() - started, error: error.message });
    throw error;
  }
}

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
    value = run(command("gh"), ["api", "--paginate", "--slurp", `repos/${expectedRepository}/releases?per_page=100`]);
  } catch {
    throw new Error("could not query GitHub releases (gh authentication required)");
  }
  let releases;
  try {
    releases = JSON.parse(value).flat();
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
  assertTargetAvailable(plan.target);
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

function preflight() {
  const context = validatePublishContext(process.env);
  if (!context.ok) throw new Error(context.failures.join("; "));
  if (!validateOrigin(run("git", ["remote", "get-url", "origin"]))) throw new Error("origin must be the canonical maxverse-ai/aria repository");
  run("gh", ["auth", "status"], { capture: false });
  const repository = JSON.parse(run("gh", ["api", `repos/${expectedRepository}`]));
  if (repository.full_name !== expectedRepository || !repository.permissions?.push) throw new Error("authenticated gh user needs push permission to the canonical repository");
  const immutable = JSON.parse(run("gh", ["api", `repos/${expectedRepository}/immutable-releases`]));
  if (immutable.enabled !== true) throw new Error("repository release immutability must be enabled before publication");
  const toolchain = JSON.parse(run(process.execPath, ["tools/infra-doctor.mjs", "--json"]));
  assertCleanWorktree();
  const commit = run("git", ["rev-parse", "HEAD"]);
  const remote = run("git", ["ls-remote", "origin", "refs/heads/main"]).split(/\s/)[0];
  if (commit !== remote) throw new Error("preflight requires the exact remote main commit");
  const plan = releasePlan();
  if (!plan.ok) throw new Error(plan.failures.join("; "));
  assertTargetAvailable(plan.target);
  if (!plan.needsVersionChange) {
    for (const suffix of ["md", "zh.md"]) {
      const notes = readFileSync(resolve(root, `docs/releases/v${plan.target}.${suffix}`), "utf8");
      if (!notes.trim() || !notes.includes(`# Aria v${plan.target}`)) throw new Error("release notes must match the target version");
    }
  }
  return { ...plan, commit, toolchain, ready: !plan.needsVersionChange };
}

function assertTargetAvailable(version) {
  if (run("git", ["ls-remote", "origin", `refs/tags/v${version}`])) throw new Error("target release tag already exists remotely");
  const releases = JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${expectedRepository}/releases?per_page=100`])).flat();
  if (releases.some((release) => release.tag_name === `v${version}`)) throw new Error("target release or draft already exists; inspect its session before resuming");
}

function sessionIdentity(commit) {
  return {
    repository: expectedRepository, commit, version: readJson("package.json").version,
    node: process.version, pnpm: run(command("corepack"), ["pnpm", "--version"]),
    platform: process.platform, arch: process.arch,
  };
}

function publishRelease(resume = false) {
  const commonDirectory = resolve(root, run("git", ["rev-parse", "--git-common-dir"]));
  return withReleaseLock(commonDirectory, () => {
    const directory = resolve(commonDirectory, "aria-releases");
    mkdirSync(directory, { recursive: true });
    const version = readJson("package.json").version;
    stageLog = resolve(directory, `${version}.jsonl`);
    const sessionPath = resolve(directory, `${version}.json`);
    try {
      if (resume) {
        const context = validatePublishContext(process.env);
        if (!context.ok) throw new Error(context.failures.join("; "));
        if (!validateOrigin(run("git", ["remote", "get-url", "origin"]))) throw new Error("origin must be canonical");
        run("gh", ["auth", "status"], { capture: false });
        const repository = JSON.parse(run("gh", ["api", `repos/${expectedRepository}`]));
        if (repository.full_name !== expectedRepository || !repository.permissions?.push) throw new Error("resume requires canonical repository push permission");
        if (JSON.parse(run("gh", ["api", `repos/${expectedRepository}/immutable-releases`])).enabled !== true) throw new Error("release immutability must be enabled");
        assertCleanWorktree();
        const commit = refreshMain();
        const session = readSession(sessionPath, sessionIdentity(commit), root);
        return publishSession(session, sessionPath);
      }
      const plan = releaseStage("preflight", preflight);
      if (!plan.ready) throw new Error("merge the prepared version before publishing");
      if (existsSync(sessionPath)) throw new Error("release session exists; use pnpm release:resume to inspect and continue");
      const commit = refreshMain();
      releaseStage("validate", () => run(command("pnpm"), ["release:validate"], { capture: false }));
      releaseStage("package", () => run(process.execPath, ["tools/artifact.mjs", "build"], { capture: false }));
      releaseStage("inspect-package", () => run(command("pnpm"), ["artifact:verify"], { capture: false }));
      releaseStage("prepare-assets", () => run(process.execPath, ["tools/github-release.mjs", "prepare"], { capture: false }));
      assertCleanWorktree();
      if (refreshMain() !== commit) throw new Error("main changed during local release validation");
      const result = verifyReleaseArtifact();
      const tag = `v${result.target}`;
      writeFileSync(resolve(root, "artifacts/release-notes.md"), renderReleaseNotes(`docs/releases/${tag}.md`, tag), "utf8");
      const assets = [result.tarball, "artifacts/manifest.json", "artifacts/SHA256SUMS", "artifacts/release.json", "artifacts/aria-install.mjs", result.worker, "artifacts/aria-worker-manifest.json", "artifacts/aria-worker-SHA256SUMS"];
      const session = {
        schemaVersion: 1, ...sessionIdentity(commit), tag, stage: "prepared",
        notesSha256: sha256File(resolve(root, "artifacts/release-notes.md")),
        assets: assets.map((asset) => ({ name: basename(asset), size: statSync(resolve(root, asset)).size, sha256: sha256File(resolve(root, asset)) })),
      };
      saveSession(sessionPath, session);
      return publishSession(session, sessionPath);
    } catch (error) {
      throw new Error(`${error.message}\nRelease log: ${stageLog}\nSession: ${sessionPath}. Inspect any GitHub draft before retrying.`, { cause: error });
    } finally { stageLog = undefined; }
  });
}

function publishSession(session, sessionPath) {
  const notes = resolve(root, "artifacts/release-notes.md");
  if (sha256File(notes) !== session.notesSha256) throw new Error("rendered release notes changed");
  const inspect = () => {
    const releases = JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${expectedRepository}/releases?per_page=100`])).flat();
    const matches = releases.filter((release) => release.tag_name === session.tag);
    if (matches.length > 1) throw new Error("multiple releases match the session tag");
    const release = matches[0];
    if (!release && session.releaseId) throw new Error("recorded release is missing; inspect before restarting");
    if (release && session.releaseId && release.id !== session.releaseId) throw new Error("release ID changed");
    return release;
  };
  const result = releaseStage("upload-and-verify", () => resumeSession(session, {
    inspect,
    create: () => run("gh", ["release", "create", session.tag, "--repo", expectedRepository, "--target", session.commit, "--title", `Aria ${session.tag}`, "--notes-file", notes, "--draft"], { capture: false }),
    save: () => saveSession(sessionPath, session),
    upload: (asset) => releaseStage(`upload:${asset.name}`, () => run("gh", ["release", "upload", session.tag, resolve(root, "artifacts", asset.name), "--repo", expectedRepository], { capture: false })),
    verify: (release) => {
      const downloaded = mkdtempSync(resolve(tmpdir(), "aria-release-download-"));
      try {
        run("gh", ["release", "download", session.tag, "--repo", expectedRepository, "--dir", downloaded]);
        for (const asset of release.assets) {
          const output = resolve(downloaded, asset.name);
          if (sha256File(output) !== session.assets.find((expected) => expected.name === asset.name).sha256) throw new Error(`downloaded asset mismatch: ${asset.name}`);
        }
      } finally { rmSync(downloaded, { recursive: true, force: true }); }
    },
    checkMain: () => {
      if (refreshMain() !== session.commit) throw new Error("main changed before publication; draft retained");
      const remoteTag = run("git", ["ls-remote", "origin", `refs/tags/${session.tag}`, `refs/tags/${session.tag}^{}`]);
      if (remoteTag) throw new Error("release tag appeared before publication; inspect before resuming");
    },
    publish: () => run("gh", ["release", "edit", session.tag, "--repo", expectedRepository, "--draft=false", "--latest"], { capture: false }),
    verifyTag: () => {
      run("git", ["fetch", "origin", `refs/tags/${session.tag}:refs/tags/${session.tag}`]);
      if (run("git", ["rev-parse", `${session.tag}^{commit}`]) !== session.commit) throw new Error("published tag does not match tested commit");
    },
  }));
  return { published: true, tag: session.tag, commit: session.commit, url: result.html_url, session: sessionPath };
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const operation = process.argv[2] ?? "plan";
  if (operation === "plan") return print(releasePlan());
  if (operation === "preflight") return print(releaseStage("preflight", preflight));
  if (operation === "prepare-patch") return print(preparePatch());
  if (operation === "verify") return print(verifyReleaseArtifact());
  if (operation === "publish") return print(publishRelease());
  if (operation === "resume") return print(publishRelease(true));
  if (operation === "publish-gate") {
    throw new Error("npm publication is unsupported; use pnpm release:publish for host-local GitHub Releases");
  }
  throw new Error("release command must be plan, preflight, prepare-patch, verify, publish, resume, or publish-gate");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
