export interface SessionAsset {
  name: string;
  size: number;
  sha256: string;
}

export interface ReleaseSession {
  schemaVersion: number;
  repository: string;
  version: string;
  tag: string;
  commit: string;
  node: string;
  pnpm: string;
  platform: string;
  arch: string;
  notesSha256: string;
  assets: SessionAsset[];
  stage?: string;
  releaseId?: number;
}

export interface RemoteRelease {
  id: number;
  tag_name: string;
  target_commitish: string;
  draft: boolean;
  prerelease: boolean;
  immutable?: boolean;
  assets: Array<{ name: string; size: number; digest?: string }>;
}

export function saveSession(path: string, session: ReleaseSession): void;
export function readSession(path: string, expected: Pick<ReleaseSession, "repository" | "version" | "commit" | "node" | "pnpm" | "platform" | "arch">, root: string): ReleaseSession;
export function reconcileAssets(session: ReleaseSession, release: RemoteRelease): SessionAsset[];
export function resumeSession(session: ReleaseSession, operations: {
  inspect(): RemoteRelease | undefined;
  create(): void;
  save(): void;
  upload(asset: SessionAsset): void;
  verify(release: RemoteRelease): void;
  checkMain(): void;
  publish(): void;
  verifyTag(): void;
}): RemoteRelease;
