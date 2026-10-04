import { mkdir, readdir } from 'node:fs/promises';
import type {
  DistributionChannel,
  ReleaseDescriptor,
  ReleaseSource,
} from '../../application/distribution/types';
import { versionFromTag } from '../../application/distribution/semver';
import type { CommandRunner } from './command-runner';
import { ProcessCommandRunner } from './command-runner';

interface GitHubReleaseResponse {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  immutable?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

const REQUIRED_FIXED_ASSETS = ['release.json', 'manifest.json', 'SHA256SUMS', 'aria-install.mjs'];

/** Public GitHub Releases adapter. Authentication remains entirely owned by gh. */
export class GitHubReleaseSource implements ReleaseSource {
  constructor(
    private readonly repository = 'maxverse-ai/aria',
    private readonly runner: CommandRunner = new ProcessCommandRunner(),
    private readonly ghCommand = 'gh',
  ) {}

  async list(channel: DistributionChannel): Promise<ReleaseDescriptor[]> {
    if (channel !== 'stable') throw new Error(`unsupported release channel: ${channel}`);
    const response = await this.runner.run(this.ghCommand, [
      'api',
      '-H', 'Accept: application/vnd.github+json',
      `repos/${this.repository}/releases?per_page=100`,
    ]);
    let values: unknown;
    try {
      values = JSON.parse(response.stdout);
    } catch (err) {
      throw new Error('GitHub release API returned invalid JSON', { cause: err });
    }
    if (!Array.isArray(values)) throw new Error('GitHub release API returned a non-array response');

    const releases: ReleaseDescriptor[] = [];
    for (const value of values) {
      const release = value as GitHubReleaseResponse;
      if (release.draft !== false || release.prerelease !== false || release.immutable !== true) continue;
      if (typeof release.tag_name !== 'string' || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) continue;
      if (typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at))) continue;
      const assets = parseAssetNames(release.assets);
      if (!REQUIRED_FIXED_ASSETS.every((asset) => assets.includes(asset))) continue;
      const version = versionFromTag(release.tag_name);
      const commitResponse = await this.runner.run(this.ghCommand, [
        'api',
        '-H', 'Accept: application/vnd.github+json',
        `repos/${this.repository}/commits/${release.tag_name}`,
        '--jq', '.sha',
      ]);
      const commit = commitResponse.stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`release ${release.tag_name} resolved to an invalid commit`);
      releases.push({
        channel: 'stable',
        repository: this.repository,
        tag: release.tag_name,
        version,
        commit,
        publishedAt: release.published_at,
        immutable: true,
        assets,
      });
    }
    return releases;
  }

  async download(release: ReleaseDescriptor, directory: string): Promise<void> {
    if (release.repository !== this.repository) throw new Error('release repository mismatch');
    if (!release.immutable) throw new Error('refusing to download a mutable release');
    await assertEmptyDirectory(directory);
    await this.runner.run(this.ghCommand, [
      'release', 'download', release.tag,
      '--repo', this.repository,
      '--dir', directory,
    ]);
  }
}

function parseAssetNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const asset of value) {
    const name = (asset as { name?: unknown } | null)?.name;
    if (typeof name === 'string') names.push(name);
  }
  return [...new Set(names)].sort();
}

async function assertEmptyDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const entries = await readdir(directory);
  if (entries.length > 0) throw new Error(`release download directory is not empty: ${directory}`);
}
