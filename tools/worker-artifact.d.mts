export interface WorkerArtifactManifest {
  schemaVersion: 1;
  kind: "aria-worker";
  repository: "maxverse-ai/aria";
  version: string;
  commit: string;
  protocolVersion: 1;
  entry: "worker/index.js";
  tarball: string;
  sha256: string;
}

export function validateWorkerManifest(
  manifest: WorkerArtifactManifest,
  expected: { version: string; commit: string },
): WorkerArtifactManifest;
