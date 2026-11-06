/**
 * What a client should do after an error. Responses never include state,
 * tokens, identities or thrown action details; `code` is the stable contract.
 */
export type LiveErrorRecovery =
  /** The request was malformed or tampered with; retrying the same bytes cannot succeed. */
  | 'fix-request'
  /** Authentication, CSRF, origin or authorization refused it; do not retry automatically. */
  | 'deny'
  /** Server state for this component is gone or incompatible; reload the page. */
  | 'reload'
  /** Another change won; refresh the component and let the user repeat the intent. */
  | 'resync'
  /** Transient capacity, concurrency or shutdown condition; retry later with a new request. */
  | 'retry-later'
  /** Server or host configuration fault; not caused by the client. */
  | 'server';

export interface LiveErrorDescription {
  readonly status: number;
  readonly recovery: LiveErrorRecovery;
  readonly description: string;
}

function entry(
  status: number,
  recovery: LiveErrorRecovery,
  description: string,
): LiveErrorDescription {
  return Object.freeze({ status, recovery, description });
}

/**
 * Every public error code emitted by Live routes, mounts, downloads and text
 * streams as `{ statusCode, code }`. Codes are stable within a protocol major;
 * new codes may be added in minor releases, existing codes keep their status.
 */
export const LIVE_ERROR_CODES = Object.freeze({
  INVALID_REQUEST: entry(
    400,
    'fix-request',
    'Envelope failed strict schema validation.',
  ),
  INVALID_CAPABILITIES: entry(
    400,
    'fix-request',
    'Malformed x-nestvexa-capabilities header.',
  ),
  UNEXPECTED_INPUT: entry(
    400,
    'fix-request',
    'Input sent to an action or $sync that takes none.',
  ),
  INVALID_STREAM_REFERENCE: entry(
    400,
    'fix-request',
    'Text stream reference is not a snapshot/revision pair.',
  ),
  STREAM_REQUEST: entry(
    400,
    'fix-request',
    'Text stream request body is invalid.',
  ),
  IDENTITY_REQUIRED: entry(
    401,
    'deny',
    'The host identity resolver returned no valid identity.',
  ),
  ORIGIN_REJECTED: entry(
    403,
    'deny',
    'Origin header does not equal the configured origin.',
  ),
  CSRF_REJECTED: entry(
    403,
    'deny',
    'x-nestvexa-csrf does not match the identity token.',
  ),
  ACTION_FORBIDDEN: entry(
    403,
    'deny',
    'Host authorize policy refused this action or $sync.',
  ),
  COMPONENT_FORBIDDEN: entry(
    403,
    'deny',
    'Host authorize policy refused $mount.',
  ),
  STREAM_FORBIDDEN: entry(
    403,
    'deny',
    'Host authorize policy refused $stream:<id>.',
  ),
  COMPONENT_MISMATCH: entry(
    403,
    'deny',
    'The snapshot belongs to a different component route.',
  ),
  IDENTITY_CHANGED: entry(
    403,
    'deny',
    'The identity changed while a stream was open.',
  ),
  ADMISSION_REQUIRED: entry(
    403,
    'deny',
    'A handler ran without passing Live admission.',
  ),
  UNKNOWN_ACTION: entry(
    404,
    'fix-request',
    'The action is not registered on this component.',
  ),
  DOWNLOAD_UNAVAILABLE: entry(
    404,
    'reload',
    'Download token unknown, expired, consumed or not owned.',
  ),
  STREAM_METHOD: entry(405, 'fix-request', 'Text streams accept POST only.'),
  STALE_REVISION: entry(
    409,
    'resync',
    'The snapshot revision changed since the client rendered it.',
  ),
  COMPONENT_BUSY: entry(
    409,
    'retry-later',
    'Another request for this component instance is running.',
  ),
  ACTION_BUSY: entry(
    409,
    'retry-later',
    'An identity-scoped action is already running for this identity.',
  ),
  IDEMPOTENCY_CONFLICT: entry(
    422,
    'fix-request',
    'A request ID was reused with a different payload.',
  ),
  STATE_SCHEMA_CHANGED: entry(
    409,
    'reload',
    'Stored state no longer matches the component class.',
  ),
  REACTIVE_PROP_MUTATED: entry(
    409,
    'reload',
    'A child action changed a parent-owned @Reactive field.',
  ),
  INVALID_SNAPSHOT: entry(
    410,
    'reload',
    'State reference unknown, expired, revoked or not owned.',
  ),
  PAYLOAD_TOO_LARGE: entry(
    413,
    'fix-request',
    'Envelope or rendered HTML exceeds the documented limits.',
  ),
  CONTENT_TYPE: entry(
    415,
    'fix-request',
    'Requests must be application/json (UTF-8).',
  ),
  STATE_LOCKED: entry(
    422,
    'fix-request',
    'An update named a field that is not writable public state.',
  ),
  STATE_TYPE: entry(
    422,
    'fix-request',
    'An update changed the JSON kind of a field or failed its synthesizer.',
  ),
  STATE_INVALID: entry(
    422,
    'fix-request',
    'A @State validate callback rejected the value.',
  ),
  UNSUPPORTED_PROTOCOL: entry(
    426,
    'reload',
    'The envelope names another protocol major.',
  ),
  RATE_LIMIT: entry(
    429,
    'retry-later',
    'Per-identity request budget exhausted.',
  ),
  STREAM_CAPACITY: entry(
    429,
    'retry-later',
    'Too many concurrent text streams.',
  ),
  INVALID_STATE: entry(
    400,
    'server',
    'The store was asked to create state for an invalid component identifier.',
  ),
  INVALID_STORE_OPTIONS: entry(
    500,
    'server',
    'Store options, clock or generators are invalid.',
  ),
  STREAM_AUTHORIZATION: entry(
    500,
    'server',
    'A stream producer ran without authorization.',
  ),
  STREAM_HTTP_ADAPTER: entry(
    500,
    'server',
    'The HTTP adapter cannot stream responses.',
  ),
  DOWNLOAD_CAPACITY: entry(
    503,
    'retry-later',
    'Pending download capacity reached.',
  ),
  STORE_CAPACITY: entry(
    503,
    'retry-later',
    'State or in-flight action capacity reached.',
  ),
  LIVE_SHUTDOWN: entry(503, 'retry-later', 'The application is shutting down.'),
  STREAM_SHUTDOWN: entry(
    503,
    'retry-later',
    'The application is shutting down streams.',
  ),
  COMPUTED_TIMEOUT: entry(
    504,
    'retry-later',
    'An async @Computed exceeded its deadline.',
  ),
  HOOK_TIMEOUT: entry(
    504,
    'retry-later',
    'A lifecycle hook exceeded the component timeoutMs.',
  ),
  ACTION_TIMEOUT: entry(
    504,
    'retry-later',
    'An action exceeded the component timeoutMs.',
  ),
} as const satisfies Readonly<Record<string, LiveErrorDescription>>);

export type LiveErrorCode = keyof typeof LIVE_ERROR_CODES;
