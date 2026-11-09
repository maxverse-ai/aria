import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface Owner { pid: number; token: string }
type Outcome = 'released' | 'committed' | 'uncertain';
const MAX_GENERATIONS = 64;
export interface MailClaim { path: string; owner: Owner }

// Publish complete immutable records. Exclusive hard-link creation is the
// cross-process compare-and-set; readers never see a partly written owner.
export function publishMailRecord(path: string, value: unknown): boolean {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(value) + '\n', { mode: 0o600 });
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally { unlinkSync(temporary); }
}

function record<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function current(directory: string): { claim: MailClaim; outcome?: Outcome; submitting: boolean } | undefined {
  for (let generation = 0; generation < MAX_GENERATIONS; generation++) {
    const path = join(directory, String(generation));
    const owner = record<Owner>(path);
    if (!owner) return undefined;
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string') {
      throw new Error('invalid steer mailbox claim owner');
    }
    const submitting = record<boolean>(`${path}.submitting`) === true;
    let outcome = record<Outcome>(`${path}.outcome`);
    if (!outcome && !alive(owner.pid)) {
      outcome = submitting ? 'uncertain' : 'released';
      publishMailRecord(`${path}.outcome`, outcome);
      outcome = record<Outcome>(`${path}.outcome`);
    }
    if (outcome === 'released') continue;
    return { claim: { path, owner }, outcome, submitting };
  }
  throw new Error('steer mailbox claim retry limit reached; inspect retained mail');
}

export function mailClaimState(directory: string): 'claimed' | 'uncertain' | undefined {
  const state = current(directory);
  if (!state || state.outcome === 'committed') return undefined;
  return state.outcome === 'uncertain' ? 'uncertain' : 'claimed';
}

export function acquireMailClaim(directory: string): MailClaim | undefined {
  mkdirSync(directory, { recursive: true });
  // Released generations are never deleted or reused. Competing recovery
  // processes can only release the dead generation, never a newer owner.
  for (let generation = 0; generation < MAX_GENERATIONS; generation++) {
    const path = join(directory, String(generation));
    const owner = record<Owner>(path);
    if (owner) {
      current(directory);
      if (record<Outcome>(`${path}.outcome`) === 'released') continue;
      return undefined;
    }
    const candidate = { pid: process.pid, token: randomUUID() };
    if (publishMailRecord(path, candidate)) return { path, owner: candidate };
    // Another consumer won this generation. Re-read its immutable outcome.
    generation--;
  }
  throw new Error('steer mailbox claim retry limit reached; inspect retained mail');
}

function assertOwner(claim: MailClaim): void {
  if (record<Owner>(claim.path)?.token !== claim.owner.token || claim.owner.pid !== process.pid) {
    throw new Error('steer mailbox claim is not owned by this process');
  }
}

export function beginMailSubmission(claim: MailClaim): void {
  assertOwner(claim);
  if (record<Outcome>(`${claim.path}.outcome`)) throw new Error('steer mailbox claim already finished');
  publishMailRecord(`${claim.path}.submitting`, true);
}

export function finishMailClaim(claim: MailClaim, outcome: Outcome): void {
  assertOwner(claim);
  publishMailRecord(`${claim.path}.outcome`, outcome);
  if (record<Outcome>(`${claim.path}.outcome`) !== outcome) throw new Error('steer mailbox claim outcome conflict');
}
