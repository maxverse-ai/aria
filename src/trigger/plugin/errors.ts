export type TriggerProviderErrorKind =
  | 'transient'
  | 'authentication'
  | 'configuration'
  | 'unsupported-capability'
  | 'permanent';

export interface TriggerProviderErrorOptions extends ErrorOptions {
  kind: TriggerProviderErrorKind;
  code: string;
  retryAfterMs?: number;
}

const KINDS = new Set<TriggerProviderErrorKind>([
  'transient', 'authentication', 'configuration', 'unsupported-capability', 'permanent',
]);
const CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class TriggerProviderError extends Error {
  readonly kind: TriggerProviderErrorKind;
  readonly code: string;
  readonly retryAfterMs?: number;

  constructor(message: string, options: TriggerProviderErrorOptions) {
    if (!KINDS.has(options.kind)) throw new TypeError(`invalid trigger error kind: ${String(options.kind)}`);
    if (!CODE.test(options.code) || options.code.length > 128) {
      throw new TypeError(`invalid trigger error code: ${String(options.code)}`);
    }
    super(message, options);
    this.name = 'TriggerProviderError';
    this.kind = options.kind;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    if (options.retryAfterMs !== undefined && (
      options.kind !== 'transient' || !Number.isSafeInteger(options.retryAfterMs) || options.retryAfterMs < 0
    )) throw new TypeError('retryAfterMs is valid only for transient trigger errors');
  }

  get retryable(): boolean { return this.kind === 'transient' }
}
