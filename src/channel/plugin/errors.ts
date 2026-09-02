export type ChannelPluginErrorKind =
  | 'transient'
  | 'authentication'
  | 'configuration'
  | 'unsupported-capability'
  | 'permanent';

export interface ChannelPluginErrorOptions extends ErrorOptions {
  kind: ChannelPluginErrorKind;
  /** Stable, non-secret code suitable for logs and health surfaces. */
  code: string;
  /** Provider retry hint. Valid only for transient failures. */
  retryAfterMs?: number;
}

const ERROR_KINDS = new Set<ChannelPluginErrorKind>([
  'transient',
  'authentication',
  'configuration',
  'unsupported-capability',
  'permanent',
]);
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export class ChannelPluginError extends Error {
  readonly kind: ChannelPluginErrorKind;
  readonly code: string;
  readonly retryAfterMs?: number;

  constructor(message: string, options: ChannelPluginErrorOptions) {
    if (!ERROR_KINDS.has(options.kind)) {
      throw new TypeError(`invalid channel error kind: ${String(options.kind)}`);
    }
    if (!ERROR_CODE_PATTERN.test(options.code) || options.code.length > 128) {
      throw new TypeError(`invalid channel error code: ${String(options.code)}`);
    }
    super(message, options);
    this.name = 'ChannelPluginError';
    this.kind = options.kind;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
    if (
      options.retryAfterMs !== undefined &&
      (options.kind !== 'transient' ||
        !Number.isSafeInteger(options.retryAfterMs) ||
        options.retryAfterMs < 0)
    ) {
      throw new TypeError('retryAfterMs is valid only for transient channel errors');
    }
  }

  get retryable(): boolean {
    return this.kind === 'transient';
  }
}
