import type { ReleasePolicy } from "./release-policy.mjs";

export interface InternalReleasePlan {
  ok: boolean;
  failures: string[];
  packageName: string;
  version: string;
  tag: string;
  title: string;
  commit: string;
}

export function internalTagForVersion(version: string): string;
export function validateInternalReleaseContext(env: Record<string, string | undefined>): {
  ok: boolean;
  failures: string[];
};
export function createInternalReleasePlan(input: {
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
}): InternalReleasePlan;
