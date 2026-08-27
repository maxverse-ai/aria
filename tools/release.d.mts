import type { ReleasePolicy } from "./release-policy.mjs";

export interface ReleasePlan {
  ok: boolean;
  kind: "initial" | "patch";
  from: string | null;
  target: string;
  needsVersionChange: boolean;
  humanRequired: boolean;
  failures: string[];
}

export function normalizeVersions(values: string[]): string[];
export function selectReleasePlan(input: {
  packageVersion: string;
  policy: ReleasePolicy;
  taggedVersions?: string[];
  publishedVersions?: string[];
}): ReleasePlan;
export function validatePublishContext(env: Record<string, string | undefined>): {
  ok: boolean;
  failures: string[];
};
