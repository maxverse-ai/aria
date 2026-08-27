#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function command(name) {
  return process.platform === "win32" && ["corepack", "npm", "pnpm"].includes(name) ? `${name}.cmd` : name;
}

export function parseNumericVersion(value) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) throw new Error(`invalid tool version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareNumericVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const difference = left[index] - right[index];
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function evaluateToolchain({ nodeVersion, minimumNode, preferredNode, pnpmVersion, expectedPnpm, gitAvailable, tarAvailable, lockfileExists }) {
  const checks = [];
  const nodeSupported = compareNumericVersions(parseNumericVersion(nodeVersion), parseNumericVersion(minimumNode)) >= 0;
  checks.push({
    id: "node-supported",
    status: nodeSupported ? "pass" : "fail",
    detail: `${nodeVersion} (minimum ${minimumNode})`,
  });
  checks.push({
    id: "node-preferred",
    status: nodeVersion.replace(/^v/, "") === preferredNode ? "pass" : "warn",
    detail: `${nodeVersion} (preferred ${preferredNode})`,
  });
  checks.push({
    id: "pnpm",
    status: pnpmVersion === expectedPnpm ? "pass" : "fail",
    detail: `${pnpmVersion} (expected ${expectedPnpm})`,
  });
  checks.push({ id: "git", status: gitAvailable ? "pass" : "fail", detail: gitAvailable ? "available" : "missing" });
  checks.push({ id: "tar", status: tarAvailable ? "pass" : "fail", detail: tarAvailable ? "available" : "missing" });
  checks.push({ id: "lockfile", status: lockfileExists ? "pass" : "fail", detail: lockfileExists ? "present" : "missing" });
  return { ok: checks.every((check) => check.status !== "fail"), checks };
}

function runVersion(executable, args) {
  try {
    return execFileSync(executable, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function main() {
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  const preferredNode = readFileSync(resolve(root, ".node-version"), "utf8").trim();
  const expectedPnpm = String(packageJson.packageManager).replace(/^pnpm@/, "");
  const minimumNode = String(packageJson.engines.node).match(/\d+\.\d+\.\d+/)?.[0];
  if (!minimumNode) throw new Error("package.json engines.node must include a numeric minimum version");
  const pnpmVersion = runVersion(command("corepack"), ["pnpm", "--version"]);
  const gitVersion = runVersion(command("git"), ["--version"]);
  const tarVersion = runVersion(command("tar"), ["--version"]);
  const report = evaluateToolchain({
    nodeVersion: process.version,
    minimumNode,
    preferredNode,
    pnpmVersion: pnpmVersion ?? "missing",
    expectedPnpm,
    gitAvailable: Boolean(gitVersion),
    tarAvailable: Boolean(tarVersion),
    lockfileExists: existsSync(resolve(root, "pnpm-lock.yaml")),
  });

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const check of report.checks) {
      const mark = check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
      process.stdout.write(`${mark} ${check.id}: ${check.detail}\n`);
    }
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`toolchain doctor error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
