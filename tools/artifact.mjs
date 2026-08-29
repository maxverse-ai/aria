#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const requiredPackageFiles = [
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
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

function command(name) {
  return process.platform === "win32" && ["corepack", "npm", "pnpm"].includes(name) ? `${name}.cmd` : name;
}

function run(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: options.cwd ?? root,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    encoding: "utf8",
    stdio: options.capture === false ? "inherit" : ["ignore", "pipe", "inherit"],
  }).trim();
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function validatePackageInventory(files) {
  const names = new Set(files.map((file) => typeof file === "string" ? file : file.path));
  const missing = requiredPackageFiles.filter((path) => !names.has(path));
  if (missing.length > 0) throw new Error(`package is missing required files: ${missing.join(", ")}`);
  return [...names].sort();
}

export function validatePackageName(packageName) {
  if (typeof packageName !== "string" || !packageNamePattern.test(packageName)) {
    throw new Error("manifest package name is invalid");
  }
  return packageName;
}

export function validateManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) throw new Error("unsupported artifact manifest schemaVersion");
  validatePackageName(manifest.packageName);
  if (!/^[0-9a-f]{40}$/.test(manifest.commit)) throw new Error("manifest commit must be a full Git SHA");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) throw new Error("manifest version is invalid");
  if (!/^[0-9a-f]{64}$/.test(manifest.sha256)) throw new Error("manifest sha256 is invalid");
  if (basename(manifest.tarball) !== manifest.tarball) throw new Error("manifest tarball must be a basename");
  validatePackageInventory(manifest.files);
  return manifest;
}

function outputDirectory() {
  const index = process.argv.indexOf("--output");
  const requested = index >= 0 ? process.argv[index + 1] : "artifacts";
  if (!requested) throw new Error("--output requires a directory");
  const output = resolve(root, requested);
  const pathFromRoot = relative(root, output);
  if (pathFromRoot === "" || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error("artifact output must be a subdirectory of the repository");
  }
  return output;
}

function assertCleanWorktree() {
  const status = run(command("git"), ["status", "--porcelain", "--untracked-files=normal"]);
  if (status) throw new Error("artifact build requires a clean worktree");
}

function copyPackageFiles(packageJson, destination) {
  const included = new Set([...(packageJson.files ?? []), "package.json", "README.md", "README.zh.md", "LICENSE"]);
  for (const entry of included) {
    cpSync(resolve(root, entry), resolve(destination, entry), { recursive: true });
  }
}

function walkFiles(directory, prefix = "") {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walkFiles(path, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

function buildArtifact() {
  assertCleanWorktree();
  const output = outputDirectory();
  mkdirSync(output, { recursive: true });
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  validatePackageName(packageJson.name);
  const stagingRoot = mkdtempSync(join(tmpdir(), "aria-pack-"));
  const packageRoot = resolve(stagingRoot, "package");
  mkdirSync(packageRoot, { recursive: true });
  let tarballPath;
  let files;
  let unpackedSize;
  try {
    copyPackageFiles(packageJson, packageRoot);
    files = validatePackageInventory(walkFiles(packageRoot));
    unpackedSize = files.reduce((total, file) => total + statSync(resolve(packageRoot, file)).size, 0);
    const archiveName = `${String(packageJson.name).replace(/^@/, "").replaceAll("/", "-")}-${packageJson.version}.tgz`;
    tarballPath = resolve(output, archiveName);
    run(command("tar"), ["-czf", tarballPath, "-C", stagingRoot, "package"]);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }
  const manifest = {
    schemaVersion: 1,
    kind: "ci-candidate",
    packageName: packageJson.name,
    version: packageJson.version,
    commit: run(command("git"), ["rev-parse", "HEAD"]),
    builtAt: new Date().toISOString(),
    nodeVersion: process.version,
    pnpmVersion: run(command("corepack"), ["pnpm", "--version"]),
    platform: process.platform,
    arch: process.arch,
    tarball: basename(tarballPath),
    sha256: sha256File(tarballPath),
    unpackedSize,
    files,
  };
  validateManifest(manifest);
  const manifestPath = resolve(output, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, manifest: relative(root, manifestPath), tarball: relative(root, tarballPath), sha256: manifest.sha256 }, null, 2)}\n`);
}

function verifyArtifact() {
  const output = outputDirectory();
  const manifestPath = resolve(output, "manifest.json");
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  if (manifest.packageName !== packageJson.name) throw new Error("manifest package name does not match package.json");
  if (manifest.version !== packageJson.version) throw new Error("manifest version does not match package.json");
  const currentCommit = run(command("git"), ["rev-parse", "HEAD"]);
  if (manifest.commit !== currentCommit) throw new Error("manifest commit does not match the checked-out commit");
  const tarballPath = resolve(dirname(manifestPath), manifest.tarball);
  const actualDigest = sha256File(tarballPath);
  if (actualDigest !== manifest.sha256) throw new Error("artifact SHA-256 does not match manifest");

  const installation = mkdtempSync(join(tmpdir(), "aria-artifact-"));
  try {
    run(command("npm"), ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=optional", "--prefix", installation, tarballPath]);
    const binPath = resolve(installation, "node_modules", ...manifest.packageName.split("/"), "bin", "aria.mjs");
    const installedVersion = run(process.execPath, [binPath, "--version"], { cwd: installation });
    if (installedVersion !== manifest.version) {
      throw new Error(`installed artifact reports ${installedVersion}, expected ${manifest.version}`);
    }
  } finally {
    rmSync(installation, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify({ ok: true, version: manifest.version, commit: manifest.commit, sha256: manifest.sha256 }, null, 2)}\n`);
}

function main() {
  const operation = process.argv[2];
  if (operation === "build") return buildArtifact();
  if (operation === "verify") return verifyArtifact();
  throw new Error("artifact command must be build or verify");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`artifact error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
