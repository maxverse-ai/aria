export interface ArtifactManifest {
  schemaVersion: 1;
  kind: "ci-candidate";
  packageName: string;
  version: string;
  commit: string;
  builtAt: string;
  nodeVersion: string;
  pnpmVersion: string;
  platform: string;
  arch: string;
  tarball: string;
  sha256: string;
  unpackedSize: number;
  files: string[];
}

export function sha256File(path: string): string;
export function verifyStandaloneNodeAsset(assetPath: string, expectedOutput?: string): string;
export function validatePackageInventory(files: Array<string | { path: string }>): string[];
export function validatePackageName(packageName: string): string;
export function validateManifest(manifest: ArtifactManifest): ArtifactManifest;
