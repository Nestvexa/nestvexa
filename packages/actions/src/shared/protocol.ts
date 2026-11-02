/**
 * Wire contract shared by the Nest server runtime, the browser client and the
 * code generator. This module must stay free of Node, Nest and DOM imports.
 */
export const ACTIONS_PROTOCOL = 'nestvexa-actions/1';
export const DEFAULT_ACTIONS_PREFIX = '/_nestvexa/actions';
export const DEFAULT_CSRF_HEADER = 'x-nestvexa-csrf';
export const REQUEST_ID_HEADER = 'x-nestvexa-request-id';
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const REPLAYED_HEADER = 'idempotent-replayed';

export const ACTION_ERROR_CODES = [
  'VALIDATION',
  'FORBIDDEN',
  'UNAUTHENTICATED',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'TIMEOUT',
  'INTERNAL',
] as const;
export type ActionErrorCode = (typeof ACTION_ERROR_CODES)[number];

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ActionIssue {
  readonly path: readonly (string | number)[];
  readonly message: string;
}
export type ActionNotificationLevel = 'info' | 'success' | 'warning' | 'error';
export interface ActionNotification {
  readonly level: ActionNotificationLevel;
  readonly message: string;
}
export interface ActionRedirect {
  readonly location: string;
}
export interface ActionSuccessEnvelope<T = JsonValue> {
  readonly protocol: typeof ACTIONS_PROTOCOL;
  readonly ok: true;
  readonly requestId: string;
  readonly data: T;
  readonly redirect?: ActionRedirect;
  readonly notifications?: readonly ActionNotification[];
}
export interface ActionErrorBody {
  readonly code: ActionErrorCode;
  readonly message: string;
  /** Stable machine-readable refinement such as CSRF or IDEMPOTENCY_IN_PROGRESS. */
  readonly reason?: string;
  readonly issues?: readonly ActionIssue[];
  /** Present only when the host explicitly enables error details. */
  readonly detail?: string;
}
export interface ActionFailureEnvelope {
  readonly protocol: typeof ACTIONS_PROTOCOL;
  readonly ok: false;
  readonly requestId: string;
  readonly error: ActionErrorBody;
}
export type ActionEnvelope<T = JsonValue> =
  ActionSuccessEnvelope<T> | ActionFailureEnvelope;

export const ACTION_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const MAX_ACTION_ID_LENGTH = 64;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_ISSUES = 50;
export const MAX_MESSAGE_LENGTH = 500;
export const MAX_NOTIFICATIONS = 10;
export const MAX_REDIRECT_LENGTH = 2048;

export const DEFAULT_ERROR_MESSAGES: Readonly<Record<ActionErrorCode, string>> =
  Object.freeze({
    VALIDATION: 'The action input is invalid.',
    FORBIDDEN: 'The action is not allowed.',
    UNAUTHENTICATED: 'Authentication is required.',
    NOT_FOUND: 'The requested resource was not found.',
    CONFLICT: 'The action conflicts with the current state.',
    RATE_LIMITED: 'Too many requests. Try again later.',
    PAYLOAD_TOO_LARGE: 'The request payload is too large.',
    TIMEOUT: 'The action did not complete in time.',
    INTERNAL: 'The action failed.',
  });

const DEFAULT_STATUS: Readonly<Record<ActionErrorCode, number>> = Object.freeze(
  {
    VALIDATION: 400,
    FORBIDDEN: 403,
    UNAUTHENTICATED: 401,
    NOT_FOUND: 404,
    CONFLICT: 409,
    RATE_LIMITED: 429,
    PAYLOAD_TOO_LARGE: 413,
    TIMEOUT: 504,
    INTERNAL: 500,
  },
);

export function isActionErrorCode(value: unknown): value is ActionErrorCode {
  return (
    typeof value === 'string' &&
    (ACTION_ERROR_CODES as readonly string[]).includes(value)
  );
}

export function defaultStatusFor(code: ActionErrorCode): number {
  return DEFAULT_STATUS[code];
}

/** Maps any HTTP status (including proxy and host-filter responses) to a stable code. */
export function codeForStatus(status: number): ActionErrorCode {
  switch (status) {
    case 400:
    case 405:
    case 411:
    case 415:
    case 422:
      return 'VALIDATION';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
    case 410:
      return 'NOT_FOUND';
    case 409:
    case 412:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 429:
      return 'RATE_LIMITED';
    case 408:
    case 504:
      return 'TIMEOUT';
    default:
      return status >= 400 && status < 500 ? 'VALIDATION' : 'INTERNAL';
  }
}

/** Only same-origin absolute paths are accepted as redirect effects. */
export function isSafeRedirect(location: unknown): location is string {
  return (
    typeof location === 'string' &&
    location.length > 0 &&
    location.length <= MAX_REDIRECT_LENGTH &&
    location.startsWith('/') &&
    !location.startsWith('//') &&
    !location.includes('\\') &&
    // Reject C0 control characters and DEL (header splitting, parser confusion).
    ![...location].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  );
}

/**
 * Client property name: `add-item` -> `addItem`, version 2 -> `addItemV2`.
 * Registration rejects ids/versions whose keys collide (for example
 * `add-item` v2 and an unversioned `add-item-v2`).
 */
export function actionKey(id: string, version: number | null): string {
  const camel = id.replace(/-([a-z0-9])/g, (_match, next: string) =>
    next.toUpperCase(),
  );
  return version === null ? camel : `${camel}V${version}`;
}

export function actionPath(
  group: string,
  action: string,
  version: number | null,
): string {
  return version === null
    ? `${group}/${action}`
    : `${group}/${action}/v${version}`;
}
