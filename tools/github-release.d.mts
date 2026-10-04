import type { ReleasePolicy } from "./release-policy.mjs";

export interface GitHubReleasePlan {
  ok: boolean;
  failures: string[];
  packageName: string;
  version: string;
  tag: string;
  title: string;
  commit: string;
}

export function tagForVersion(version: string): string;
export function validateReleaseContext(env: Record<string, string | undefined>): {
  ok: boolean;
  failures: string[];
};
/**
 * Whether this release may advance the release line. The refusal lives in the
 * release path because publishing is the action that produces an external,
 * immutable effect.
 */
export function releaseLineAuthorization(input: {
  stableLine: string;
  previousLine: string | null;
  commitMessage: string;
  humanAuthorized?: boolean;
}): { ok: boolean; required: string | null; failures: string[] };
export function createGitHubReleasePlan(input: {
  packageJson: { name: string; version: string };
  policy: ReleasePolicy;
  manifest: {
    kind: string;
    packageName: string;
    version: string;
    commit: string;
    sha256: string;
  };
  commit: string;
  digest: string;
  notes: string;
}): GitHubReleasePlan;

export interface GitHubReleaseManifest {
  schemaVersion: 1;
  channel: "stable";
  repository: string;
  tag: string;
  version: string;
  commit: string;
  packageName: string;
  artifactManifest: "manifest.json";
  tarball: string;
  checksums: "SHA256SUMS";
  sha256: string;
  nodeRange: string;
  stateSchemaVersion: 1;
  minRollbackVersion: string | null;
  createdAt: string;
}

export function createReleaseManifest(input: {
  packageJson: { name: string; version: string; engines?: { node?: string } };
  plan: Pick<GitHubReleasePlan, "ok" | "tag" | "version" | "commit">;
  manifest: { tarball: string };
  digest: string;
  createdAt: string;
}): GitHubReleaseManifest;
