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
  JOBS_SEGMENT,
  JOB_ID_PATTERN,
  REPLAYED_HEADER,
  REQUEST_ID_HEADER,
  actionPath,
  codeForStatus,
  isActionErrorCode,
  isActionJobStatus,
  isSafeRedirect,
} from '../shared/protocol.js';
import type {
  ActionErrorCode,
  ActionIssue,
  ActionJobSnapshot,
  ActionJobTicket,
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
  ActionJobSnapshot,
  ActionJobStatus,
  ActionJobTicket,
  ActionNotification,
  ActionNotificationLevel,
  ActionRedirect,
  ActionSuccessEnvelope,
  JsonValue,
} from '../shared/protocol.js';
export { createActionController } from './state.js';
export type {
  ActionBinding,
  ActionController,
  ActionControllerOptions,
  ActionRefBinding,
  ActionOptimisticUpdate,
  ActionState,
  ActionStatus,
} from './state.js';
export { bindActionElement } from './element.js';
export type { ActionElementOptions } from './element.js';

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

declare const actionFields: unique symbol;
/** Phantom carrier of an action's validation field names (no runtime value). */
export interface ActionFieldsBrand<Field extends string> {
  readonly [actionFields]?: Field;
}

/**
 * Typed action function. `void` input means "no argument"; `undefined`-accepting
 * input is optional. `Field` is the union of top-level input field names that
 * validation issues can point at (see `ActionFailure`).
 */
export type ActionMethod<Input, Output, Field extends string = string> = ([
  Input,
] extends [void]
  ? (input?: null, options?: ActionCallOptions) => Promise<Output>
  : undefined extends Input
    ? (input?: Input, options?: ActionCallOptions) => Promise<Output>
    : (input: Input, options?: ActionCallOptions) => Promise<Output>) &
  ActionFieldsBrand<Field>;

/** Any generated action method. */
export type AnyActionMethod = (...args: never[]) => Promise<unknown>;
/** Resolved output of an action method (`ActionJobHandle<T>` for job actions). */
export type ActionOutputOf<M extends AnyActionMethod> = Awaited<ReturnType<M>>;
/** Validation field union of an action method (`string` when unknown). */
export type ActionFieldOf<M> =
  M extends ActionFieldsBrand<infer Field> ? Field : string;

/** A validation issue whose first path segment is a known input field. */
export interface ActionFieldIssue<Field extends string = string> {
  readonly path: readonly [] | readonly [Field, ...(string | number)[]];
  readonly message: string;
}
/** Typed failure: an `ActionClientError` whose issues name the action's input fields. */
export type ActionFailure<Field extends string = string> = ActionClientError & {
  readonly issues: readonly ActionFieldIssue<Field>[];
};
/** Discriminated result of `settle(...)` and the framework hooks' `run`. */
export type ActionSettled<Output, Field extends string = string> =
  | { readonly ok: true; readonly data: Output }
  | { readonly ok: false; readonly error: ActionFailure<Field> };

/**
 * Turns an action call into a discriminated `ActionSettled` result instead
 * of a rejection. Non-action errors (programming errors) are rethrown;
 * aborts become `{ ok: false }` with reason `ABORTED`.
 */
export async function settle<Output, Field extends string = string>(
  call: Promise<Output>,
): Promise<ActionSettled<Output, Field>> {
  try {
    return { ok: true, data: await call };
  } catch (error) {
    if (isActionClientError(error))
      return { ok: false, error: error as ActionFailure<Field> };
    if (
      typeof error === 'object' &&
      error !== null &&
      Reflect.get(error, 'name') === 'AbortError'
    )
      return {
        ok: false,
        error: new ActionClientError('INTERNAL', 'The action was cancelled.', {
          status: 0,
          reason: 'ABORTED',
          cause: error,
        }) as ActionFailure<Field>,
      };
    throw error;
  }
}

/** Handle for an accepted long-running (`job: true`) action. */
export interface ActionJobHandle<Result> {
  readonly id: string;
  /** The 202 ticket as returned by the server. */
  readonly ticket: ActionJobTicket;
  /** Realtime channel with job snapshots, when the host configured streaming. */
  readonly stream: { readonly channel: string } | undefined;
  /** One status poll (owner-bound on the server). */
  status(options?: {
    readonly signal?: AbortSignal;
  }): Promise<ActionJobSnapshot<Result>>;
  /**
   * Polls until the job settles. Resolves with the result; rejects with
   * `ActionClientError` reason `JOB_FAILED` or `JOB_CANCELLED`.
   */
  wait(options?: ActionJobWaitOptions<Result>): Promise<Result>;
  /** Requests cancellation; true when the queue accepted it. */
  cancel(): Promise<boolean>;
}
export interface ActionJobWaitOptions<Result> {
  readonly signal?: AbortSignal;
  /** Poll interval override in milliseconds (default: the ticket's `pollAfterMs`). */
  readonly intervalMs?: number;
  /** Give up after this many milliseconds (ActionClientError TIMEOUT, reason JOB_WAIT). */
  readonly timeoutMs?: number;
  readonly onProgress?: (snapshot: ActionJobSnapshot<Result>) => void;
}

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
  /** Resolves with the action data, or an `ActionJobHandle` for a 202 job ticket. */
  call(
    descriptor: ActionDescriptor,
    input: unknown,
    options?: ActionCallOptions,
  ): Promise<unknown>;
  /** Re-attaches to an accepted job (for example after a page reload). */
  job<Result = unknown>(
    ticket: ActionJobTicket | string,
  ): ActionJobHandle<Result>;
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
    Object.defineProperty(this, CLIENT_ERROR_BRAND, { value: true });
  }
}

// Registered symbol: errors created by another bundled copy of this module
// (for example a separately built island chunk) are still recognized.
const CLIENT_ERROR_BRAND = Symbol.for('nestvexa.actions.ActionClientError');

/** True for `ActionClientError`, including instances from another bundle copy. */
export function isActionClientError(
  value: unknown,
): value is ActionClientError {
  return (
    value instanceof ActionClientError ||
    (typeof value === 'object' &&
      value !== null &&
      Reflect.get(value, CLIENT_ERROR_BRAND) === true)
  );
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

  /** POSTs `{ input }` and returns the success envelope, or throws `ActionClientError`. */
  async function post(
    descriptor: ActionDescriptor,
    path: string,
    input: unknown,
    callOptions: ActionCallOptions,
  ): Promise<{
    readonly body: Record<string, unknown>;
    readonly info: ActionCallInfo;
    readonly status: number;
  }> {
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
    const url = `${baseUrl}${prefix}/${path}`;
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
      if (body['ok'] === true && response.ok)
        return { body, info, status: response.status };
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

  async function call(
    descriptor: ActionDescriptor,
    input: unknown,
    callOptions: ActionCallOptions = {},
  ): Promise<unknown> {
    validDescriptor(descriptor);
    const { body, info, status } = await post(
      descriptor,
      actionPath(descriptor.group, descriptor.action, descriptor.version),
      input,
      callOptions,
    );
    const notifications = parseNotifications(body['notifications']);
    if (notifications.length > 0)
      options.onNotifications?.(notifications, info);
    const redirect: unknown = body['redirect'];
    if (record(redirect) && isSafeRedirect(redirect['location']))
      (options.onRedirect ?? defaultRedirect)(redirect['location'], info);
    if (status === 202 || body['job'] !== undefined) {
      const ticket = parseTicket(body['job']);
      if (!ticket)
        throw new ActionClientError(
          'INTERNAL',
          'The server returned an invalid job ticket.',
          {
            status,
            reason: 'INVALID_RESPONSE',
            requestId: info.requestId,
          },
        );
      return job(ticket);
    }
    return body['data'];
  }

  const jobDescriptor = (action: 'status' | 'cancel'): ActionDescriptor =>
    Object.freeze({
      group: JOBS_SEGMENT,
      action,
      version: null,
      idempotent: false,
    });

  async function jobRequest(
    action: 'status' | 'cancel',
    id: string,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const { body } = await post(
      jobDescriptor(action),
      `${JOBS_SEGMENT}/${action}`,
      { id },
      signal === undefined ? {} : { signal },
    );
    return body['data'];
  }

  function job<Result>(
    source: ActionJobTicket | string,
  ): ActionJobHandle<Result> {
    const parsed: ActionJobTicket | undefined =
      typeof source === 'string'
        ? parseTicket({
            id: source,
            status: 'queued',
            progress: 0,
            pollAfterMs: 1000,
          })
        : parseTicket(source);
    if (!parsed) throw new TypeError('Invalid action job ticket');
    const ticket: ActionJobTicket = parsed;
    const id = ticket.id;
    async function status(
      statusOptions: { readonly signal?: AbortSignal } = {},
    ): Promise<ActionJobSnapshot<Result>> {
      const snapshot = parseSnapshot<Result>(
        await jobRequest('status', id, statusOptions.signal),
      );
      if (!snapshot || snapshot.id !== id)
        throw new ActionClientError(
          'INTERNAL',
          'The server returned an invalid job status.',
          { status: 200, reason: 'INVALID_RESPONSE' },
        );
      return snapshot;
    }
    async function wait(
      waitOptions: ActionJobWaitOptions<Result> = {},
    ): Promise<Result> {
      const interval = Math.max(
        50,
        Math.min(60_000, waitOptions.intervalMs ?? ticket.pollAfterMs),
      );
      const deadline =
        waitOptions.timeoutMs === undefined
          ? undefined
          : Date.now() + waitOptions.timeoutMs;
      for (;;) {
        const snapshot = await status(
          waitOptions.signal === undefined
            ? {}
            : { signal: waitOptions.signal },
        );
        waitOptions.onProgress?.(snapshot);
        if (snapshot.status === 'succeeded') return snapshot.result as Result;
        if (snapshot.status === 'failed')
          throw new ActionClientError(
            'INTERNAL',
            snapshot.error ?? DEFAULT_ERROR_MESSAGES.INTERNAL,
            { status: 200, reason: 'JOB_FAILED' },
          );
        if (snapshot.status === 'cancelled')
          throw new ActionClientError('CONFLICT', 'The job was cancelled.', {
            status: 200,
            reason: 'JOB_CANCELLED',
          });
        if (deadline !== undefined && Date.now() + interval > deadline)
          throw new ActionClientError(
            'TIMEOUT',
            DEFAULT_ERROR_MESSAGES.TIMEOUT,
            { status: 0, reason: 'JOB_WAIT' },
          );
        await delay(interval, waitOptions.signal);
      }
    }
    async function cancel(): Promise<boolean> {
      const data = await jobRequest('cancel', id, undefined);
      return record(data) && data['cancelled'] === true;
    }
    return Object.freeze({
      id,
      ticket,
      stream: ticket.stream,
      status,
      wait,
      cancel,
    });
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

  return Object.freeze({ call, bind, job });
}

function delay(milliseconds: number, signal: AbortSignal | undefined) {
  return new Promise<void>((resolve, rejectDelay) => {
    if (signal?.aborted) {
      rejectDelay(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      rejectDelay(signal?.reason);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function parseTicket(value: unknown): ActionJobTicket | undefined {
  if (
    !record(value) ||
    typeof value['id'] !== 'string' ||
    !JOB_ID_PATTERN.test(value['id']) ||
    !isActionJobStatus(value['status']) ||
    typeof value['progress'] !== 'number' ||
    typeof value['pollAfterMs'] !== 'number' ||
    !Number.isFinite(value['pollAfterMs'])
  )
    return undefined;
  const stream: unknown = value['stream'];
  const channel =
    record(stream) && typeof stream['channel'] === 'string'
      ? stream['channel']
      : undefined;
  return Object.freeze({
    id: value['id'],
    status: value['status'],
    progress: Math.max(0, Math.min(100, value['progress'])),
    pollAfterMs: Math.max(50, Math.min(60_000, value['pollAfterMs'])),
    ...(channel ? { stream: Object.freeze({ channel }) } : {}),
  });
}

function parseSnapshot<Result>(
  value: unknown,
): ActionJobSnapshot<Result> | undefined {
  if (
    !record(value) ||
    typeof value['id'] !== 'string' ||
    !isActionJobStatus(value['status']) ||
    typeof value['progress'] !== 'number'
  )
    return undefined;
  return Object.freeze({
    id: value['id'],
    status: value['status'],
    progress: Math.max(0, Math.min(100, value['progress'])),
    // Server-validated JSON; the generator types it from the job handler.
    result: (value['result'] ?? null) as Result | null,
    error: typeof value['error'] === 'string' ? value['error'] : null,
  });
}
