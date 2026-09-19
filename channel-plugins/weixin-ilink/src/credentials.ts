import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Post-login account credential produced by the iLink QR flow
 * (docs/WEIXIN_ILINK_PROTOCOL.md). `botToken` is bearer material: it must
 * never enter config, plans, diagnostics, or logs.
 */
export interface IlinkCredential {
  botToken: string;
  ilinkBotId: string;
  baseurl: string;
}

/** Durable credential boundary owned by the deployment's composition. */
export interface IlinkCredentialStore {
  read(): Promise<IlinkCredential | undefined>;
  write(credential: IlinkCredential): Promise<void>;
  clear(): Promise<void>;
}

/** Volatile store — used when no deployment file store is composed. */
export class InMemoryCredentialStore implements IlinkCredentialStore {
  private credential: IlinkCredential | undefined;

  constructor(initial?: IlinkCredential) {
    this.credential = initial;
  }

  async read(): Promise<IlinkCredential | undefined> {
    return this.credential;
  }

  async write(credential: IlinkCredential): Promise<void> {
    this.credential = credential;
  }

  async clear(): Promise<void> {
    this.credential = undefined;
  }
}

/**
 * Atomic single-file credential store for deployments. Writes go through a
 * same-directory rename so a crash never leaves a half-written bearer.
 */
export class FileIlinkCredentialStore implements IlinkCredentialStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<IlinkCredential | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<IlinkCredential>;
      if (
        typeof parsed.botToken !== 'string' ||
        typeof parsed.ilinkBotId !== 'string' ||
        typeof parsed.baseurl !== 'string'
      ) {
        return undefined;
      }
      return {
        botToken: parsed.botToken,
        ilinkBotId: parsed.ilinkBotId,
        baseurl: parsed.baseurl,
      };
    } catch {
      return undefined;
    }
  }

  async write(credential: IlinkCredential): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temp = join(
      dirname(this.filePath),
      `.${Math.random().toString(36).slice(2)}.tmp`,
    );
    await writeFile(temp, JSON.stringify(credential), { mode: 0o600 });
    await rename(temp, this.filePath);
  }

  async clear(): Promise<void> {
    const { rm } = await import('node:fs/promises');
    await rm(this.filePath, { force: true });
  }
}
