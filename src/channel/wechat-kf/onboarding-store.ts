import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../../platform/atomic-write';

type OnboardingMap = Record<string, { introducedAt: number }>;

/** Stores only HMAC-derived wxkf actor IDs, never raw WeChat user IDs. */
export class FileWechatKfOnboardingStore {
  private data: OnboardingMap = {};
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      this.data = normalizeOnboardingMap(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  hasIntroduced(actorId: string): boolean {
    assertActorId(actorId);
    return Boolean(this.data[actorId]);
  }

  markIntroduced(actorId: string, introducedAt = Date.now()): void {
    assertActorId(actorId);
    if (this.data[actorId]) return;
    this.data[actorId] = { introducedAt };
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .catch(() => undefined)
      .then(() => writeFileAtomic(this.path, `${JSON.stringify(this.data, null, 2)}\n`, {
        mode: 0o600,
      }));
  }
}

function normalizeOnboardingMap(input: unknown): OnboardingMap {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const result: OnboardingMap = {};
  for (const [actorId, value] of Object.entries(input)) {
    if (!isActorId(actorId) || !value || typeof value !== 'object') continue;
    const introducedAt = (value as { introducedAt?: unknown }).introducedAt;
    if (typeof introducedAt === 'number') result[actorId] = { introducedAt };
  }
  return result;
}

function assertActorId(actorId: string): void {
  if (!isActorId(actorId)) throw new Error('invalid anonymized wxkf actorId');
}

function isActorId(actorId: string): boolean {
  return /^wxkf_[0-9A-Za-z_-]{20,}$/.test(actorId);
}
