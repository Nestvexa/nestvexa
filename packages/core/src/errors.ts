/** Stable diagnostic codes; messages never include configuration secrets. */
export type NestvexaErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'DUPLICATE_REGISTRATION'
  | 'UNKNOWN_REGISTRATION'
  | 'REGISTRY_SEALED'
  | 'UNSUPPORTED_CAPABILITY';

/** Every code with its meaning, for documentation and diagnostics tooling. */
export const NESTVEXA_ERROR_CODES: Readonly<Record<NestvexaErrorCode, string>> =
  Object.freeze({
    INVALID_CONFIGURATION:
      'Configuration or a registration identifier failed validation at startup.',
    DUPLICATE_REGISTRATION:
      'Two registrations used the same identifier in one registry.',
    UNKNOWN_REGISTRATION:
      'A lookup named an identifier that was not registered.',
    REGISTRY_SEALED:
      'A registration was attempted after the registry was sealed.',
    UNSUPPORTED_CAPABILITY:
      'A feature required a capability that its adapter declares unsupported.',
  });

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

/** One invalid configuration path and what was expected there; never the supplied value. */
export interface NestvexaConfigIssue {
  readonly path: string;
  readonly expected: string;
}

/** Startup validation failure listing every invalid path at once. */
export class NestvexaConfigError extends NestvexaError {
  readonly issues: readonly NestvexaConfigIssue[];
  constructor(issues: readonly NestvexaConfigIssue[]) {
    super(
      'INVALID_CONFIGURATION',
      `Invalid Nestvexa configuration at ${issues
        .map((issue) => `${issue.path} (expected ${issue.expected})`)
        .join('; ')}`,
    );
    this.name = 'NestvexaConfigError';
    this.issues = Object.freeze([...issues]);
  }
}
