const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface StableVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
}

export function parseStableVersion(value: string): StableVersion {
  const match = STABLE_VERSION.exec(value);
  if (!match) throw new Error(`invalid stable version: ${value}`);
  return {
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

export function compareStableVersions(left: string, right: string): number {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function versionFromInternalTag(tag: string): string {
  const prefix = 'internal-v';
  if (!tag.startsWith(prefix)) throw new Error(`unsupported internal release tag: ${tag}`);
  return parseStableVersion(tag.slice(prefix.length)).raw;
}

export function newestRelease<T extends { version: string }>(releases: readonly T[]): T | undefined {
  return [...releases].sort((a, b) => compareStableVersions(b.version, a.version))[0];
}
