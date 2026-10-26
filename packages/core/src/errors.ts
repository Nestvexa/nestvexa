/** Stable diagnostic codes; messages never include configuration secrets. */
export type NestvexaErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'DUPLICATE_REGISTRATION'
  | 'UNKNOWN_REGISTRATION'
  | 'REGISTRY_SEALED'
  | 'UNSUPPORTED_CAPABILITY';

/** Configuration/extension error, distinct from a public HTTP response. */
export class NestvexaError extends Error {
  constructor(
    public readonly code: NestvexaErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NestvexaError';
  }
}
