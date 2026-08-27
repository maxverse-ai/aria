import type {
  NativeReadChange,
  NativeReadCursor,
  NativeReadResource,
  NativeReadResourceType,
} from './native-read-types';

export type NativeReadResourceDraft<T extends NativeReadResource = NativeReadResource> =
  T extends NativeReadResource ? Omit<T, 'revision'> : never;

export interface NativeReadUpsert<T extends NativeReadResource = NativeReadResource> {
  eventId: string;
  changedAt?: string;
  resource: NativeReadResourceDraft<T>;
}

export interface NativeReadDelete {
  eventId: string;
  changedAt?: string;
  resourceType: NativeReadResourceType;
  resourceId: string;
}

export interface NativeReadChangePage {
  after: NativeReadCursor | null;
  nextCursor: NativeReadCursor;
  hasMore: boolean;
  changes: readonly NativeReadChange[];
}

export interface NativeReadRepository {
  readonly profileId: string;
  initialize(): Promise<void>;
  currentCursor(): Promise<NativeReadCursor>;
  get<T extends NativeReadResource>(resourceType: T['resourceType'], id: string): Promise<T | undefined>;
  list<T extends NativeReadResource>(resourceType: T['resourceType']): Promise<readonly T[]>;
  upsert<T extends NativeReadResource>(input: NativeReadUpsert<T>): Promise<NativeReadChange>;
  delete(input: NativeReadDelete): Promise<NativeReadChange>;
  changes(after: NativeReadCursor | null, limit?: number): Promise<NativeReadChangePage>;
}

export type NativeReadRepositoryErrorCode =
  | 'INVALID_INPUT'
  | 'CURSOR_INVALID'
  | 'PROFILE_MISMATCH'
  | 'REVISION_CONFLICT'
  | 'STORAGE_CORRUPT';

export class NativeReadRepositoryError extends Error {
  constructor(
    readonly code: NativeReadRepositoryErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NativeReadRepositoryError';
  }
}
