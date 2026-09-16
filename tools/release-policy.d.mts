export interface ReleasePolicy {
  schemaVersion: number;
  stableLine: string;
  patchMode: string;
  batchWindowMinutes: number;
  securityPatchMode: string;
  prereleaseMode: string;
  requireHumanForMinor: boolean;
  requireHumanForMajor: boolean;
  requireHumanForStablePromotion: boolean;
  frozen: boolean;
}

export interface VersionTransitionResult {
  ok: boolean;
  level: "major" | "minor" | "patch" | "stable-promotion" | "prerelease" | "none";
  from: string;
  to: string;
  failures: string[];
}

export function parseVersion(input: string): {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
};
export function validatePolicy(policy: ReleasePolicy): ReleasePolicy;
export function versionLine(version: { major: number; minor: number }): string;
/** Newest published release tag, across the internal and formal namespaces. */
export function latestReleaseTagVersion(): {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
} | null;
export function classifyTransition(from: string, to: string): VersionTransitionResult["level"];
export function nextVersion(current: string, level: "patch" | "minor" | "major"): string;
export function verifyTransition(input: {
  from: string;
  to: string;
  policy: ReleasePolicy;
  humanAuthorized?: boolean;
}): VersionTransitionResult;
