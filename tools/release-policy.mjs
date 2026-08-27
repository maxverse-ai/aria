#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const linePattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseVersion(input) {
  const match = versionPattern.exec(input);
  if (!match) throw new Error(`invalid semantic version: ${input}`);
  return {
    raw: input,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

export function validatePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("release policy must be an object");
  }
  if (policy.schemaVersion !== 1) throw new Error("unsupported release policy schemaVersion");
  if (typeof policy.stableLine !== "string" || !linePattern.test(policy.stableLine)) {
    throw new Error("stableLine must be MAJOR.MINOR");
  }
  if (!['automatic', 'manual'].includes(policy.patchMode)) {
    throw new Error("patchMode must be automatic or manual");
  }
  if (!Number.isInteger(policy.batchWindowMinutes) || policy.batchWindowMinutes < 0) {
    throw new Error("batchWindowMinutes must be a non-negative integer");
  }
  if (!['immediate', 'batched', 'manual'].includes(policy.securityPatchMode)) {
    throw new Error("securityPatchMode must be immediate, batched, or manual");
  }
  if (!['automatic', 'manual'].includes(policy.prereleaseMode)) {
    throw new Error("prereleaseMode must be automatic or manual");
  }
  for (const key of [
    "requireHumanForMinor",
    "requireHumanForMajor",
    "requireHumanForStablePromotion",
    "frozen",
  ]) {
    if (typeof policy[key] !== "boolean") throw new Error(`${key} must be boolean`);
  }
  return policy;
}

export function classifyTransition(fromInput, toInput) {
  const from = typeof fromInput === "string" ? parseVersion(fromInput) : fromInput;
  const to = typeof toInput === "string" ? parseVersion(toInput) : toInput;
  if (to.major !== from.major) return "major";
  if (to.minor !== from.minor) return "minor";
  if (to.patch !== from.patch) return "patch";
  if (from.prerelease && !to.prerelease) return "stable-promotion";
  if (from.prerelease !== to.prerelease) return "prerelease";
  return "none";
}

function versionLine(version) {
  return `${version.major}.${version.minor}`;
}

function parsePrerelease(value) {
  const match = /^(alpha|beta|rc)\.([1-9]\d*)$/.exec(value ?? "");
  if (!match) return null;
  return { stage: match[1], number: Number(match[2]) };
}

export function nextVersion(currentInput, level) {
  const current = typeof currentInput === "string" ? parseVersion(currentInput) : currentInput;
  if (level === "patch") return `${current.major}.${current.minor}.${current.patch + 1}`;
  if (level === "minor") return `${current.major}.${current.minor + 1}.0`;
  if (level === "major") return `${current.major + 1}.0.0`;
  throw new Error("level must be patch, minor, or major");
}

export function verifyTransition({ from: fromInput, to: toInput, policy, humanAuthorized = false }) {
  validatePolicy(policy);
  const from = parseVersion(fromInput);
  const to = parseVersion(toInput);
  const level = classifyTransition(from, to);
  const failures = [];

  if (policy.frozen) failures.push("release policy is frozen");
  if (versionLine(to) !== policy.stableLine) {
    failures.push(`target ${to.raw} is outside authorized release line ${policy.stableLine}`);
  }
  if (level === "none") failures.push("target version does not advance the current version");

  if (level === "patch") {
    if (policy.patchMode !== "automatic") failures.push("patch releases are manual");
    if (from.prerelease) failures.push("a patch release cannot skip stable promotion of its source version");
    if (to.prerelease) failures.push("a patch transition cannot introduce a prerelease");
    if (to.patch !== from.patch + 1 || versionLine(from) !== versionLine(to)) {
      failures.push("patch target must be exactly the next patch on the same release line");
    }
  }

  if (level === "minor") {
    if (policy.requireHumanForMinor && !humanAuthorized) failures.push("minor release requires human authorization");
    if (to.minor !== from.minor + 1 || to.patch !== 0) failures.push("minor target must be the next minor with patch zero");
  }

  if (level === "major") {
    if (policy.requireHumanForMajor && !humanAuthorized) failures.push("major release requires human authorization");
    if (to.major !== from.major + 1 || to.minor !== 0 || to.patch !== 0) {
      failures.push("major target must be the next major with minor and patch zero");
    }
  }

  if (level === "stable-promotion" && policy.requireHumanForStablePromotion && !humanAuthorized) {
    failures.push("stable promotion requires human authorization");
  }
  if (level === "prerelease") {
    if (policy.prereleaseMode !== "automatic") failures.push("prerelease advancement is manual");
    if (!from.prerelease) {
      failures.push("cannot move a stable release back to prerelease");
    } else {
      const current = parsePrerelease(from.prerelease);
      const target = parsePrerelease(to.prerelease);
      const stages = ["alpha", "beta", "rc"];
      if (!current || !target) {
        failures.push("prerelease versions must use alpha.N, beta.N, or rc.N");
      } else {
        const currentStage = stages.indexOf(current.stage);
        const targetStage = stages.indexOf(target.stage);
        const advancesCounter = targetStage === currentStage && target.number === current.number + 1;
        const advancesStage = targetStage === currentStage + 1 && target.number === 1;
        if (!advancesCounter && !advancesStage) {
          failures.push("prerelease target must increment its counter or advance one stage at .1");
        }
      }
    }
  }

  return { ok: failures.length === 0, level, from: from.raw, to: to.raw, failures };
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), "utf8"));
}

function readJsonAtRef(ref, relativePath) {
  if (!/^[0-9A-Za-z._/-]+$/.test(ref) || ref.includes("..")) throw new Error(`invalid Git ref: ${ref}`);
  try {
    return JSON.parse(execFileSync("git", ["show", `${ref}:${relativePath}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch {
    return null;
  }
}

function readRepositoryState() {
  const policy = validatePolicy(readJson(".release-policy.json"));
  const packageVersion = parseVersion(readJson("package.json").version);
  return { policy, packageVersion };
}

function latestTagVersion() {
  try {
    const output = execFileSync("git", ["tag", "--list", "v*", "--sort=-version:refname"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    for (const tag of output.split("\n").filter(Boolean)) {
      try {
        return parseVersion(tag.replace(/^v/, ""));
      } catch {
        // Ignore non-SemVer tags and continue to the next candidate.
      }
    }
    return null;
  } catch {
    return null;
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function main() {
  const command = process.argv[2] ?? "check";
  const { policy, packageVersion } = readRepositoryState();

  if (command === "check") {
    if (versionLine(packageVersion) !== policy.stableLine) {
      throw new Error(`package version ${packageVersion.raw} is outside authorized release line ${policy.stableLine}`);
    }
    const baseRef = argument("--base-ref") ?? process.env.ARIA_RELEASE_BASE_REF;
    let transition = null;
    if (baseRef && !/^0+$/.test(baseRef)) {
      const basePackage = readJsonAtRef(baseRef, "package.json");
      if (!basePackage?.version) throw new Error(`cannot read package.json at base ref ${baseRef}`);
      const basePolicyValue = readJsonAtRef(baseRef, ".release-policy.json");
      const humanAuthorized = process.env.ARIA_RELEASE_HUMAN_AUTHORIZED === "true";
      if (basePolicyValue) {
        const basePolicy = validatePolicy(basePolicyValue);
        if (basePolicy.stableLine !== policy.stableLine && !humanAuthorized) {
          throw new Error("changing stableLine requires protected human authorization");
        }
      }
      if (basePackage.version !== packageVersion.raw) {
        transition = verifyTransition({
          from: basePackage.version,
          to: packageVersion.raw,
          policy,
          humanAuthorized,
        });
        if (!transition.ok) throw new Error(transition.failures.join("; "));
      }
    }
    print({
      ok: true,
      packageVersion: packageVersion.raw,
      stableLine: policy.stableLine,
      frozen: policy.frozen,
      baseRef: baseRef ?? null,
      transition,
    });
    return;
  }

  if (command === "plan") {
    const level = argument("--level") ?? "patch";
    const tagged = latestTagVersion();
    const current = tagged ?? packageVersion;
    const target = nextVersion(current, level);
    const result = verifyTransition({ from: current.raw, to: target, policy, humanAuthorized: false });
    print({ ...result, source: tagged ? "git-tag" : "package.json", humanRequired: ["minor", "major"].includes(result.level) });
    return;
  }

  if (command === "verify") {
    const from = argument("--from");
    const to = argument("--to");
    if (!from || !to) throw new Error("verify requires --from and --to");
    const result = verifyTransition({
      from,
      to,
      policy,
      humanAuthorized: process.env.ARIA_RELEASE_HUMAN_AUTHORIZED === "true",
    });
    print(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  throw new Error(`unknown release policy command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release policy error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
