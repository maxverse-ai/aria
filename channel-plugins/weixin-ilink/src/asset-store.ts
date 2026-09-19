import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ChannelPluginError } from '@maxverse-ai/aria';

/**
 * Package-owned media asset boundary. iLink CDN bytes are downloaded,
 * decrypted, and persisted by the provider package itself — core treats
 * `assetRef` as opaque. Content-addressed ids make a redelivered inbound
 * download idempotent: the same plaintext writes the same assetRef.
 */

export const ILINK_ASSET_REF_PREFIX = 'ilink-asset:';

export interface IlinkStoredAsset {
  content: Buffer;
  contentType: string;
  filename?: string;
}

export interface IlinkAssetStore {
  /** Persist asset bytes and return the opaque assetRef for envelopes. */
  put(asset: IlinkStoredAsset): Promise<string>;
  /** Resolve a previously issued assetRef; undefined for foreign refs. */
  resolve(assetRef: string): Promise<IlinkStoredAsset | undefined>;
}

export function ilinkAssetRef(content: Buffer): string {
  return `${ILINK_ASSET_REF_PREFIX}${createHash('sha256').update(content).digest('hex')}`;
}

/** Volatile store for tests and compositions without a stateDir. */
export class InMemoryAssetStore implements IlinkAssetStore {
  private readonly assets = new Map<string, IlinkStoredAsset>();

  async put(asset: IlinkStoredAsset): Promise<string> {
    const ref = ilinkAssetRef(asset.content);
    this.assets.set(ref, {
      content: Buffer.from(asset.content),
      contentType: asset.contentType,
      ...(asset.filename !== undefined ? { filename: asset.filename } : {}),
    });
    return ref;
  }

  async resolve(assetRef: string): Promise<IlinkStoredAsset | undefined> {
    const stored = this.assets.get(assetRef);
    return stored
      ? { ...stored, content: Buffer.from(stored.content) }
      : undefined;
  }
}

interface IlinkAssetMeta {
  contentType: string;
  filename?: string;
}

/**
 * Atomic file-backed store under `<stateDir>/<instanceId>/assets/`.
 * `<id>.bin` holds decrypted bytes, `<id>.json` the metadata; both are
 * mode 0600 and written via same-directory rename.
 */
export class FileIlinkAssetStore implements IlinkAssetStore {
  constructor(private readonly dir: string) {}

  async put(asset: IlinkStoredAsset): Promise<string> {
    const ref = ilinkAssetRef(asset.content);
    const id = ref.slice(ILINK_ASSET_REF_PREFIX.length);
    const existing = await this.resolve(ref);
    if (existing) return ref;
    await mkdir(this.dir, { recursive: true });
    const meta: IlinkAssetMeta = {
      contentType: asset.contentType,
      ...(asset.filename !== undefined ? { filename: asset.filename } : {}),
    };
    await this.atomicWrite(`${id}.json`, Buffer.from(JSON.stringify(meta)));
    await this.atomicWrite(`${id}.bin`, asset.content);
    return ref;
  }

  async resolve(assetRef: string): Promise<IlinkStoredAsset | undefined> {
    if (
      !assetRef.startsWith(ILINK_ASSET_REF_PREFIX) ||
      !/^[0-9a-f]{64}$/.test(assetRef.slice(ILINK_ASSET_REF_PREFIX.length))
    ) {
      return undefined;
    }
    const id = assetRef.slice(ILINK_ASSET_REF_PREFIX.length);
    try {
      const meta = JSON.parse(
        await readFile(join(this.dir, `${id}.json`), 'utf8'),
      ) as IlinkAssetMeta;
      const content = await readFile(join(this.dir, `${id}.bin`));
      return {
        content,
        contentType: meta.contentType,
        ...(meta.filename !== undefined ? { filename: meta.filename } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private async atomicWrite(name: string, bytes: Buffer): Promise<void> {
    const target = join(this.dir, name);
    const temp = join(this.dir, `.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, target);
  }
}

export function assertIlinkAssetStore(store: unknown): asserts store is IlinkAssetStore {
  if (
    !store ||
    typeof (store as IlinkAssetStore).put !== 'function' ||
    typeof (store as IlinkAssetStore).resolve !== 'function'
  ) {
    throw new ChannelPluginError('weixin-ilink asset store is invalid', {
      kind: 'configuration',
      code: 'weixin-ilink-config',
    });
  }
}
