import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { hostname, userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import * as lockfile from 'proper-lockfile';
import type { AppPaths } from './app-paths';
import { paths } from './paths';
import { writeFileAtomic } from '../platform/atomic-write';

/**
 * Local AES-256-GCM keystore for App Secrets and similar.
 *
 * Layout on disk:
 *   ~/.aria/secrets.enc      — JSON map { id → encrypted envelope }
 *   ~/.aria/.keystore.salt   — 32 random bytes, generated once
 *
 * Both files are chmod 0600. The encryption key is derived (PBKDF2-SHA256,
 * 100k iters) from `hostname + userInfo().username + salt`. This is
 * **defense-in-depth against accidental disclosure** (backups, git commits,
 * log dumps) — *not* against a same-user process actively decrypting. That
 * threat needs a real OS keychain, which is out of scope for this bridge
 * given lark-cli already terminates secrets in its own keychain on bind.
 */

const KEY_LEN = 32;
const IV_LEN = 12; // GCM standard
const TAG_LEN = 16; // GCM auth tag
const PBKDF2_ITER = 100_000;
const FILE_VERSION = 1;
const derivedKeyCache = new Map<string, { salt: string; key: Buffer }>();

interface Envelope {
  /** base64 of 12-byte IV */
  iv: string;
  /** base64 of ciphertext */
  data: string;
  /** base64 of 16-byte GCM auth tag */
  tag: string;
}

interface StoreFile {
  version: number;
  entries: Record<string, Envelope>;
}

export type KeystorePaths = Pick<AppPaths, 'secretsFile' | 'keystoreSaltFile'>;

/** The stable target is never renamed with the encrypted file. Every operation,
 * including salt initialization and reads, participates in this transaction. */
async function withStoreLock<T>(storePaths: KeystorePaths, fn: (normalized: KeystorePaths) => Promise<T>): Promise<T> {
  const secretsFile = await canonicalFile(storePaths.secretsFile);
  const keystoreSaltFile = await canonicalFile(storePaths.keystoreSaltFile);
  const target = `${secretsFile}.lock`;
  await writeFile(target, '', { flag: 'a', mode: 0o600 });
  await chmod(target, 0o600).catch(() => undefined);
  const release = await lockfile.lock(target, {
    realpath: false, stale: 30_000, update: 10_000,
    retries: { retries: 100, minTimeout: 10, maxTimeout: 100 },
  });
  try { return await fn({ secretsFile, keystoreSaltFile }); }
  finally { await release(); }
}

async function canonicalFile(file: string): Promise<string> {
  const absolute = resolve(file);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  return join(await realpath(dirname(absolute)), basename(absolute));
}

/** Read + return the full keystore. Missing file or unreadable → empty store. */
async function readStore(storePaths: KeystorePaths = paths): Promise<StoreFile> {
  try {
    const text = await readFile(storePaths.secretsFile, 'utf8');
    const parsed = JSON.parse(text) as Partial<StoreFile>;
    if (parsed?.version !== FILE_VERSION || !parsed.entries) return emptyStore();
    return { version: parsed.version, entries: { ...parsed.entries } };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    throw err;
  }
}

function emptyStore(): StoreFile {
  return { version: FILE_VERSION, entries: {} };
}

async function writeStore(store: StoreFile, storePaths: KeystorePaths = paths): Promise<void> {
  await writeFileAtomic(storePaths.secretsFile, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * Load the salt, or generate one if absent. The salt is **not a secret** —
 * an attacker that can read this file can also read the keystore. Its job
 * is to ensure two users on the same machine don't derive the same key.
 */
async function loadOrCreateSalt(storePaths: KeystorePaths, allowCreate: boolean): Promise<Buffer> {
  try {
    const buf = await readFile(storePaths.keystoreSaltFile);
    if (buf.length === KEY_LEN) return buf;
    throw new Error('invalid keystore salt; refusing to replace an existing salt');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (!allowCreate) throw new Error('keystore salt is missing for existing encrypted entries');
  const salt = randomBytes(KEY_LEN);
  await writeFileAtomic(storePaths.keystoreSaltFile, salt, { mode: 0o600 });
  return salt;
}

async function deriveKey(storePaths: KeystorePaths, allowCreate = false): Promise<Buffer> {
  const cacheKey = `${storePaths.keystoreSaltFile}`;
  const salt = await loadOrCreateSalt(storePaths, allowCreate);
  const saltIdentity = salt.toString('hex');
  const cached = derivedKeyCache.get(cacheKey);
  if (cached?.salt === saltIdentity) return cached.key;
  const seed = `${hostname()}|${userInfo().username}`;
  const key = pbkdf2Sync(seed, salt, PBKDF2_ITER, KEY_LEN, 'sha256');
  derivedKeyCache.set(cacheKey, { salt: saltIdentity, key });
  return key;
}

function encrypt(key: Buffer, plaintext: string): Envelope {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    data: enc.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decrypt(key: Buffer, env: Envelope): string {
  const iv = Buffer.from(env.iv, 'base64');
  const data = Buffer.from(env.data, 'base64');
  const tag = Buffer.from(env.tag, 'base64');
  if (iv.length !== IV_LEN) throw new Error('invalid IV length');
  if (tag.length !== TAG_LEN) throw new Error('invalid auth tag length');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}

/** Look up an entry by id (e.g. "app-cli_xxx"). Returns plaintext or
 * `undefined` when not present. Errors (decryption failure, invalid file)
 * propagate. */
export async function getSecret(
  id: string,
  storePaths: KeystorePaths = paths,
): Promise<string | undefined> {
  return withStoreLock(storePaths, async (normalized) => {
    const store = await readStore(normalized);
    const env = store.entries[id];
    if (!env) return undefined;
    const key = await deriveKey(normalized);
    return decrypt(key, env);
  });
}

/** Store / overwrite the secret for `id`. */
export async function setSecret(
  id: string,
  plaintext: string,
  storePaths: KeystorePaths = paths,
): Promise<void> {
  await withStoreLock(storePaths, async (normalized) => {
    const store = await readStore(normalized);
    const key = await deriveKey(normalized, Object.keys(store.entries).length === 0);
    store.entries[id] = encrypt(key, plaintext);
    await writeStore(store, normalized);
  });
}

/** Remove an entry. Returns true if something was removed. */
export async function removeSecret(
  id: string,
  storePaths: KeystorePaths = paths,
): Promise<boolean> {
  return withStoreLock(storePaths, async (normalized) => {
    const store = await readStore(normalized);
    if (!(id in store.entries)) return false;
    delete store.entries[id];
    await writeStore(store, normalized);
    return true;
  });
}

/** List ids (no secrets in the output, by design). */
export async function listSecretIds(storePaths: KeystorePaths = paths): Promise<string[]> {
  return withStoreLock(storePaths, async (normalized) => Object.keys((await readStore(normalized)).entries));
}

export function clearKeystoreDerivedKeyCache(): void {
  derivedKeyCache.clear();
}

export function keystoreDerivedKeyCacheSize(): number {
  return derivedKeyCache.size;
}
