/**
 * Browser-safe, framework-neutral client for `@nestvexa/actions`.
 * No Node, Nest or DOM-library imports: it runs in browsers, workers, Node
 * fetch and edge runtimes. The generated module binds typed methods to it.
 */
import {
  ACTIONS_PROTOCOL,
  DEFAULT_ACTIONS_PREFIX,
  DEFAULT_CSRF_HEADER,
  DEFAULT_ERROR_MESSAGES,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
  REPLAYED_HEADER,
  REQUEST_ID_HEADER,
  actionPath,
  codeForStatus,
  isActionErrorCode,
  isSafeRedirect,
} from '../shared/protocol.js';
import type {
  ActionErrorCode,
  ActionIssue,
  ActionNotification,
} from '../shared/protocol.js';

export {
  ACTIONS_PROTOCOL,
  ACTION_ERROR_CODES,
  DEFAULT_ACTIONS_PREFIX,
  DEFAULT_CSRF_HEADER,
  actionKey,
  codeForStatus,
} from '../shared/protocol.js';
export type {
  ActionEnvelope,
  ActionErrorBody,
  ActionErrorCode,
  ActionFailureEnvelope,
  ActionIssue,
  ActionNotification,
  ActionNotificationLevel,
  ActionRedirect,
  ActionSuccessEnvelope,
  JsonValue,
} from '../shared/protocol.js';

/** Static action identity emitted by the generator; never user-controlled at runtime. */
export interface ActionDescriptor {
  readonly group: string;
  readonly action: string;
  readonly version: number | null;
  readonly idempotent: boolean;
}
export type ActionManifest = Readonly<
  Record<string, Readonly<Record<string, ActionDescriptor>>>
>;

export interface ActionCallOptions {
  readonly signal?: AbortSignal;
  /** Explicit key for idempotent actions (16-128 of A-Z a-z 0-9 _ -). Generated when omitted. */
  readonly idempotencyKey?: string;
  /** Client-side deadline in milliseconds; aborts the fetch. */
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Typed action function. `void` input means "no argument"; `undefined`-accepting input is optional. */
export type ActionMethod<Input, Output> = [Input] extends [void]
  ? (input?: null, options?: ActionCallOptions) => Promise<Output>
  : undefined extends Input
    ? (input?: Input, options?: ActionCallOptions) => Promise<Output>
    : (input: Input, options?: ActionCallOptions) => Promise<Output>;

export interface ActionCallInfo {
  readonly descriptor: ActionDescriptor;
  readonly requestId: string | undefined;
  /** True when the server replayed a stored idempotent result. */
  readonly replayed: boolean;
}

export interface ActionsClientOptions {
  /** Origin or base URL prefix, default '' (same origin). */
  readonly baseUrl?: string;
  /** Must match `ActionsModule` prefix (including any Nest global prefix), default `/_nestvexa/actions`. */
  readonly prefix?: string;
  readonly fetch?: typeof fetch;
  /** CSRF token or getter. Default: `<meta name="nestvexa-csrf" content="...">` when a document exists. */
  readonly csrf?: string | (() => string | null | undefined);
  readonly csrfHeader?: string;
  readonly credentials?: RequestCredentials;
  readonly headers?: Readonly<Record<string, string>>;
  /** Redirect effect handler. Default: `location.assign(path)` when running in a browser. */
  readonly onRedirect?: (location: string, info: ActionCallInfo) => void;
  readonly onNotifications?: (
    notifications: readonly ActionNotification[],
    info: ActionCallInfo,
  ) => void;
  readonly createIdempotencyKey?: () => string;
}

export interface ActionsClient {
  call(
    descriptor: ActionDescriptor,
    input: unknown,
    options?: ActionCallOptions,
  ): Promise<unknown>;
  /** Binds a generated manifest into `{ group: { action(input, options) } }`. */
  bind(
    manifest: ActionManifest,
  ): Readonly<
    Record<
      string,
      Readonly<
        Record<
          string,
          (input?: unknown, options?: ActionCallOptions) => Promise<unknown>
        >
      >
    >
  >;
}

/** Normalized failure, including network, proxy and host-filter responses. */
export class ActionClientError extends Error {
  readonly code: ActionErrorCode;
  readonly status: number;
  readonly reason: string | undefined;
  readonly issues: readonly ActionIssue[];
  readonly requestId: string | undefined;
  readonly detail: string | undefined;
  constructor(
    code: ActionErrorCode,
    message: string,
    details: {
      readonly status: number;
      readonly reason?: string | undefined;
      readonly issues?: readonly ActionIssue[] | undefined;
      readonly requestId?: string | undefined;
      readonly detail?: string | undefined;
      readonly cause?: unknown;
    },
  ) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = 'ActionClientError';
    this.code = code;
    this.status = details.status;
    this.reason = details.reason;
    this.issues = details.issues ?? [];
    this.requestId = details.requestId;
    this.detail = details.detail;
  }
}

export function isActionClientError(
  value: unknown,
): value is ActionClientError {
  return value instanceof ActionClientError;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function metaCsrf(): string | undefined {
  const document: unknown = Reflect.get(globalThis, 'document');
  if (typeof document !== 'object' || document === null) return undefined;
  const query: unknown = Reflect.get(document, 'querySelector');
  if (typeof query !== 'function') return undefined;
  const element: unknown = Reflect.apply(query, document, [
    'meta[name="nestvexa-csrf"]',
  ]);
  if (typeof element !== 'object' || element === null) return undefined;
  const getAttribute: unknown = Reflect.get(element, 'getAttribute');
  if (typeof getAttribute !== 'function') return undefined;
  const content: unknown = Reflect.apply(getAttribute, element, ['content']);
  return typeof content === 'string' && content.length > 0
    ? content
    : undefined;
}

function defaultRedirect(location: string): void {
  const target: unknown = Reflect.get(globalThis, 'location');
  if (typeof target !== 'object' || target === null) return;
  const assign: unknown = Reflect.get(target, 'assign');
  if (typeof assign === 'function') Reflect.apply(assign, target, [location]);
}

function defaultKey(): string {
  const crypto: unknown = Reflect.get(globalThis, 'crypto');
  const random: unknown =
    typeof crypto === 'object' && crypto !== null
      ? Reflect.get(crypto, 'randomUUID')
      : undefined;
  if (typeof random !== 'function')
    throw new Error(
      'crypto.randomUUID is unavailable; pass createIdempotencyKey or idempotencyKey',
    );
  const value: unknown = Reflect.apply(random, crypto, []);
  if (typeof value !== 'string')
    throw new Error('crypto.randomUUID returned a non-string');
  return value;
}

function parseIssues(value: unknown): readonly ActionIssue[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((issue: unknown) => {
    if (
      !record(issue) ||
      typeof issue['message'] !== 'string' ||
      !Array.isArray(issue['path'])
    )
      return [];
    const path = issue['path'].filter(
      (segment: unknown): segment is string | number =>
        typeof segment === 'string' || typeof segment === 'number',
    );
    return [{ path, message: issue['message'] }];
  });
}

function parseNotifications(value: unknown): readonly ActionNotification[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 10).flatMap((entry: unknown) => {
    if (
      !record(entry) ||
      typeof entry['message'] !== 'string' ||
      !['info', 'success', 'warning', 'error'].includes(String(entry['level']))
    )
      return [];
    return [
      {
        level: entry['level'] as ActionNotification['level'],
        message: entry['message'],
      },
    ];
  });
}

function validDescriptor(descriptor: ActionDescriptor): void {
  if (
    !record(descriptor) ||
    typeof descriptor.group !== 'string' ||
    typeof descriptor.action !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(descriptor.group) ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(descriptor.action) ||
    (descriptor.version !== null &&
      (!Number.isSafeInteger(descriptor.version) || descriptor.version < 1))
  )
    throw new TypeError('Invalid action descriptor');
}

/** Creates a fetch-based client. Every call is a POST with a JSON `{ input }` body. */
export function createActionsClient(
  options: ActionsClientOptions = {},
): ActionsClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
  const prefix = options.prefix ?? DEFAULT_ACTIONS_PREFIX;
  if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix))
    throw new TypeError('Invalid actions prefix');
  const csrfHeader = options.csrfHeader ?? DEFAULT_CSRF_HEADER;
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const createKey = options.createIdempotencyKey ?? defaultKey;

  const csrfToken = (): string | undefined => {
    const source = options.csrf;
    const value =
      typeof source === 'function' ? source() : (source ?? metaCsrf());
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  };

  async function call(
    descriptor: ActionDescriptor,
    input: unknown,
    callOptions: ActionCallOptions = {},
  ): Promise<unknown> {
    validDescriptor(descriptor);
    const headers: Record<string, string> = {
      ...options.headers,
      ...callOptions.headers,
      accept: 'application/json',
      'content-type': 'application/json',
    };
    const token = csrfToken();
    if (token !== undefined) headers[csrfHeader] = token;
    if (descriptor.idempotent) {
      const key = callOptions.idempotencyKey ?? createKey();
      if (!IDEMPOTENCY_KEY_PATTERN.test(key))
        throw new TypeError(
          'Idempotency keys must be 16-128 characters of A-Z a-z 0-9 _ -',
        );
      headers[IDEMPOTENCY_HEADER] = key;
    }
    const controller = new AbortController();
    const forward = () => controller.abort(callOptions.signal?.reason);
    if (callOptions.signal?.aborted) forward();
    else callOptions.signal?.addEventListener('abort', forward, { once: true });
    const timer =
      callOptions.timeoutMs === undefined
        ? undefined
        : setTimeout(
            () =>
              controller.abort(
                new ActionClientError(
                  'TIMEOUT',
                  DEFAULT_ERROR_MESSAGES.TIMEOUT,
                  {
                    status: 0,
                    reason: 'CLIENT_DEADLINE',
                  },
                ),
              ),
            callOptions.timeoutMs,
          );
    const url = `${baseUrl}${prefix}/${actionPath(descriptor.group, descriptor.action, descriptor.version)}`;
    let response: Response;
    let text: string;
    try {
      response = await fetcher(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(input === undefined ? {} : { input }),
        credentials: options.credentials ?? 'same-origin',
        signal: controller.signal,
        redirect: 'error',
      });
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason ?? error;
      throw new ActionClientError('INTERNAL', 'The action request failed.', {
        status: 0,
        reason: 'NETWORK',
        cause: error,
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      callOptions.signal?.removeEventListener('abort', forward);
    }
    const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
    let body: unknown;
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    const info: ActionCallInfo = {
      descriptor,
      requestId,
      replayed: response.headers.get(REPLAYED_HEADER) === 'true',
    };
    if (record(body) && body['protocol'] === ACTIONS_PROTOCOL) {
      if (body['ok'] === true && response.ok) {
        const notifications = parseNotifications(body['notifications']);
        if (notifications.length > 0)
          options.onNotifications?.(notifications, info);
        const redirect: unknown = body['redirect'];
        if (record(redirect) && isSafeRedirect(redirect['location']))
          (options.onRedirect ?? defaultRedirect)(redirect['location'], info);
        return body['data'];
      }
      const error: unknown = body['error'];
      if (
        body['ok'] === false &&
        record(error) &&
        isActionErrorCode(error['code'])
      )
        throw new ActionClientError(
          error['code'],
          typeof error['message'] === 'string'
            ? error['message']
            : DEFAULT_ERROR_MESSAGES[error['code']],
          {
            status: response.status,
            reason:
              typeof error['reason'] === 'string' ? error['reason'] : undefined,
            issues: parseIssues(error['issues']),
            requestId:
              typeof body['requestId'] === 'string'
                ? body['requestId']
                : requestId,
            detail:
              typeof error['detail'] === 'string' ? error['detail'] : undefined,
          },
        );
    }
    // Host error mode, proxies and gateways: normalize by HTTP status.
    const code: ActionErrorCode = response.ok
      ? 'INTERNAL'
      : codeForStatus(response.status);
    const hostCode = record(body) ? body['code'] : undefined;
    throw new ActionClientError(
      isActionErrorCode(hostCode) ? hostCode : code,
      response.ok
        ? 'The server returned an invalid action response.'
        : DEFAULT_ERROR_MESSAGES[code],
      {
        status: response.status,
        reason: response.ok
          ? 'INVALID_RESPONSE'
          : record(body) && typeof body['reason'] === 'string'
            ? body['reason']
            : undefined,
        issues: record(body) ? parseIssues(body['issues']) : [],
        requestId,
      },
    );
  }

  function bind(manifest: ActionManifest) {
    if (!record(manifest)) throw new TypeError('Invalid action manifest');
    const groups: Record<
      string,
      Readonly<
        Record<
          string,
          (input?: unknown, options?: ActionCallOptions) => Promise<unknown>
        >
      >
    > = {};
    for (const [groupKey, actions] of Object.entries(manifest)) {
      if (!record(actions)) throw new TypeError('Invalid action manifest');
      const methods: Record<
        string,
        (input?: unknown, options?: ActionCallOptions) => Promise<unknown>
      > = {};
      for (const [actionKey, descriptor] of Object.entries(actions)) {
        validDescriptor(descriptor);
        const frozen = Object.freeze({ ...descriptor });
        methods[actionKey] = (
          input?: unknown,
          callOptions?: ActionCallOptions,
        ) => call(frozen, input, callOptions);
      }
      groups[groupKey] = Object.freeze(methods);
    }
    return Object.freeze(groups);
  }

  return Object.freeze({ call, bind });
}
