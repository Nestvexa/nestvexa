import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import type {
  BeforeApplicationShutdown,
  OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ActionError, reject, sanitizeIssues } from './errors.js';
import { MemoryIdempotencyStore } from './idempotency.js';
import type {
  ActionIdempotencyStore,
  StoredActionOutcome,
} from './idempotency.js';
import { AcceptedJob } from './jobs.js';
import type { ActionJobOwner, ActionJobRecord } from './jobs.js';
import { KeyedMutex, createFixedWindowRateLimit } from './limits.js';
import type { ActionRateLimit } from './limits.js';
import type {
  ActionDefinition,
  ActionDescriptor,
  ActionGroupDefinition,
} from './metadata.js';
import type {
  ActionCallLog,
  ActionSpan,
  ActionSpanAttributes,
  NormalizedActionsOptions,
} from './options.js';
import { ActionsApplicationRegistry } from './registration.js';
import { ActionResult } from './results.js';
import { runSchema } from './schema.js';
import { admissionFor, admit, requestIdFor } from './state.js';
import type { ActionIdentity } from './state.js';
import {
  inspectJsonInput,
  stableStringify,
  toJsonSafe,
} from './shared/json.js';
import {
  ACTIONS_PROTOCOL,
  DEFAULT_ERROR_MESSAGES,
  IDEMPOTENCY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
  JOBS_SEGMENT,
  JOB_ID_PATTERN,
  MAX_MESSAGE_LENGTH,
  REPLAYED_HEADER,
  REQUEST_ID_HEADER,
  codeForStatus,
  isActionJobStatus,
} from './shared/protocol.js';
import type {
  ActionErrorBody,
  ActionErrorCode,
  ActionFailureEnvelope,
  ActionIssue,
  ActionJobSnapshot,
  ActionJobTicket,
  ActionSuccessEnvelope,
  JsonValue,
} from './shared/protocol.js';

/** Per-request tracing/logging state; ended exactly once with the final status. */
interface Observation {
  readonly descriptor: ActionDescriptor;
  readonly requestId: string;
  readonly started: number;
  readonly span: ActionSpan | undefined;
  /** True when the response 'finish'/'close' events report the final status. */
  readonly streamed: boolean;
  code?: ActionErrorCode;
  reason?: string;
  replayed: boolean;
  jobId?: string;
  ended: boolean;
}
const observations = new WeakMap<object, Observation>();

export const ACTIONS_OPTIONS = Symbol('nestvexa:actions-options');

type AbortKind = 'timeout' | 'disconnect' | 'shutdown';
const abortKinds = new WeakMap<object, AbortKind>();
function abortReason(kind: AbortKind): Error {
  const reason = new Error(
    kind === 'timeout'
      ? 'Server action deadline exceeded'
      : kind === 'disconnect'
        ? 'Client disconnected'
        : 'Application shutdown',
  );
  reason.name = kind === 'timeout' ? 'TimeoutError' : 'AbortError';
  abortKinds.set(reason, kind);
  return reason;
}
function abortError(reason: unknown): ActionError {
  const kind =
    typeof reason === 'object' && reason !== null
      ? abortKinds.get(reason)
      : undefined;
  if (kind === 'disconnect')
    return new ActionError('TIMEOUT', 'The request was aborted.', {
      status: 408,
      reason: 'CLIENT_CLOSED',
    });
  if (kind === 'shutdown')
    return new ActionError('INTERNAL', undefined, {
      status: 503,
      reason: 'SHUTDOWN',
    });
  return new ActionError('TIMEOUT', undefined, { reason: 'DEADLINE' });
}

function header(request: object, name: string): string | undefined {
  const headers: unknown = Reflect.get(request, 'headers');
  if (typeof headers !== 'object' || headers === null) return undefined;
  const value: unknown = Reflect.get(headers, name);
  return typeof value === 'string' ? value : undefined;
}
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
/** Constant-time comparison over fixed-length digests (no length oracle). */
function secretEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}
function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
interface ClosableResponse {
  readonly writableEnded: boolean;
  readonly writableFinished?: boolean;
  readonly statusCode?: number;
  on(event: 'close' | 'finish', listener: () => void): unknown;
  off(event: 'close' | 'finish', listener: () => void): unknown;
}
function rawResponse(response: unknown): ClosableResponse | undefined {
  const candidate: unknown =
    typeof response === 'object' && response !== null && 'raw' in response
      ? Reflect.get(response, 'raw')
      : response;
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof Reflect.get(candidate, 'on') === 'function' &&
    typeof Reflect.get(candidate, 'off') === 'function'
  )
    return candidate as ClosableResponse;
  return undefined;
}

export interface DescribedError {
  readonly status: number;
  readonly body: ActionErrorBody;
}

/**
 * Admission, invocation and envelope logic shared by the generated routes.
 * Nest still owns route matching, guards, interceptors, pipes and filters.
 */
@Injectable()
export class ActionsRuntime
  implements BeforeApplicationShutdown, OnApplicationShutdown
{
  #closed = false;
  readonly #logger = new Logger('NestvexaActions');
  readonly #inflight = new Set<AbortController>();
  readonly #mutex: KeyedMutex;
  readonly #store: ActionIdempotencyStore;
  readonly #ownsStore: boolean;
  readonly #rateLimit: (ActionRateLimit & { clear?: () => void }) | undefined;
  readonly #descriptors = new Map<ActionDefinition, ActionDescriptor>();

  constructor(
    @Inject(ACTIONS_OPTIONS) readonly options: NormalizedActionsOptions,
    @Inject(ActionsApplicationRegistry)
    private readonly registry: ActionsApplicationRegistry,
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
  ) {
    this.registry.register(this, options.prefix, options.groups);
    this.#mutex = new KeyedMutex(options.maxQueuedPerKey);
    this.#ownsStore = options.idempotencyStore === undefined;
    this.#store = options.idempotencyStore ?? new MemoryIdempotencyStore();
    this.#rateLimit =
      options.rateLimit === false
        ? undefined
        : (options.rateLimit ?? createFixedWindowRateLimit());
    for (const group of options.groups)
      for (const action of group.actions)
        this.#descriptors.set(
          action,
          Object.freeze({
            group: group.id,
            action: action.id,
            version: action.version,
            idempotent: action.idempotent,
          }),
        );
  }

  descriptor(action: ActionDefinition): ActionDescriptor {
    const descriptor = this.#descriptors.get(action);
    if (!descriptor) throw new Error('Unregistered server action');
    return descriptor;
  }

  setHeader(response: unknown, name: string, value: string): void {
    this.adapterHost.httpAdapter.setHeader(response, name, value);
  }

  async #identity(request: object): Promise<ActionIdentity> {
    const resolved: unknown = await this.options.resolveIdentity(request);
    if (resolved === null || resolved === undefined)
      reject('UNAUTHENTICATED', 'IDENTITY_REQUIRED');
    if (typeof resolved !== 'object')
      throw new Error('resolveIdentity must return an ActionIdentity or null');
    const subject: unknown = Reflect.get(resolved, 'subject');
    const tenant: unknown = Reflect.get(resolved, 'tenant');
    const csrfToken: unknown = Reflect.get(resolved, 'csrfToken');
    if (
      typeof subject !== 'string' ||
      subject.length < 1 ||
      subject.length > 512
    )
      throw new Error(
        'resolveIdentity returned an invalid subject (1-512 characters)',
      );
    if (
      tenant !== undefined &&
      (typeof tenant !== 'string' || tenant.length < 1 || tenant.length > 512)
    )
      throw new Error('resolveIdentity returned an invalid tenant');
    if (
      csrfToken !== undefined &&
      (typeof csrfToken !== 'string' ||
        csrfToken.length < 16 ||
        csrfToken.length > 512)
    )
      throw new Error(
        'resolveIdentity returned an invalid csrfToken (16-512 characters)',
      );
    return Object.freeze({
      subject,
      ...(tenant === undefined ? {} : { tenant }),
      ...(csrfToken === undefined ? {} : { csrfToken }),
    });
  }

  /**
   * Runs as the first class guard of every generated controller: origin,
   * media type, size, identity, CSRF, rate limit, body shape, idempotency key
   * and host authorization, before application guards.
   */
  async admit(
    request: object,
    response: unknown,
    group: ActionGroupDefinition,
    action: ActionDefinition,
  ): Promise<void> {
    const descriptor = this.descriptor(action);
    this.#observe(request, response, descriptor);
    const { requestId, identity, input } = await this.#gate(
      request,
      response,
      descriptor,
    );
    if (
      action.inputIndex === undefined &&
      input !== undefined &&
      input !== null
    )
      reject('VALIDATION', 'UNEXPECTED_INPUT');
    const key = header(request, IDEMPOTENCY_HEADER);
    if (action.idempotent) {
      if (key === undefined || !IDEMPOTENCY_KEY_PATTERN.test(key))
        reject('VALIDATION', 'IDEMPOTENCY_KEY');
    } else if (key !== undefined)
      reject('VALIDATION', 'IDEMPOTENCY_UNSUPPORTED');
    await this.#authorize(identity, descriptor, request);
    if (this.#closed) reject('INTERNAL', 'SHUTDOWN', 503);
    const controller = new AbortController();
    admit(request, {
      group,
      action,
      controller,
      input,
      context: Object.freeze({
        requestId,
        identity,
        action: descriptor,
        signal: controller.signal,
        idempotencyKey: action.idempotent ? key : undefined,
      }),
    });
  }

  /** Host authorization: only a literal `true` admits (truthy values do not). */
  async #authorize(
    identity: ActionIdentity,
    descriptor: ActionDescriptor,
    request: object,
  ): Promise<void> {
    const allowed: unknown = await this.options.authorize(
      identity,
      descriptor,
      request,
    );
    if (allowed !== true) reject('FORBIDDEN', 'POLICY');
  }

  /**
   * Checks shared by action routes and job routes: origin, media type,
   * size, identity, CSRF, rate limit and `{ input }` body shape.
   */
  async #gate(
    request: object,
    response: unknown,
    descriptor: ActionDescriptor,
  ): Promise<{
    readonly requestId: string;
    readonly identity: ActionIdentity;
    readonly input: unknown;
  }> {
    const requestId = requestIdFor(request);
    this.setHeader(response, REQUEST_ID_HEADER, requestId);
    this.setHeader(response, 'cache-control', 'no-store');
    if (this.#closed) reject('INTERNAL', 'SHUTDOWN', 503);
    if (Reflect.get(request, 'method') !== 'POST')
      reject('VALIDATION', 'METHOD', 405);
    const origin = header(request, 'origin');
    if (origin === undefined || !this.options.origins.has(origin))
      reject('FORBIDDEN', 'ORIGIN');
    if (
      !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
        header(request, 'content-type') ?? '',
      )
    )
      reject('VALIDATION', 'CONTENT_TYPE', 415);
    const declared = header(request, 'content-length');
    if (
      declared !== undefined &&
      (!/^\d{1,12}$/.test(declared) ||
        Number(declared) > this.options.maxBodyBytes)
    )
      reject('PAYLOAD_TOO_LARGE', 'BODY_SIZE');
    const identity = await this.#identity(request);
    if (this.options.csrfRequired) {
      const token = header(request, this.options.csrfHeader);
      if (
        identity.csrfToken === undefined ||
        token === undefined ||
        !secretEqual(token, identity.csrfToken)
      )
        reject('FORBIDDEN', 'CSRF');
    }
    if (
      this.#rateLimit &&
      !(await this.#rateLimit({ identity, action: descriptor, request }))
    )
      reject('RATE_LIMITED', 'RATE_LIMIT');
    const body: unknown = Reflect.get(request, 'body');
    if (!plainObject(body)) reject('VALIDATION', 'BODY_SHAPE');
    const inspection = inspectJsonInput(body, {
      maxDepth: this.options.maxDepth,
      maxNodes: this.options.maxNodes,
    });
    if (!inspection.ok) {
      if (inspection.problem === 'DEPTH')
        reject('PAYLOAD_TOO_LARGE', 'JSON_DEPTH');
      if (inspection.problem === 'NODES')
        reject('PAYLOAD_TOO_LARGE', 'JSON_NODES');
      if (inspection.problem === 'FORBIDDEN_KEY')
        reject('VALIDATION', 'FORBIDDEN_KEY');
      reject('VALIDATION', 'BODY_SHAPE');
    }
    for (const key of Object.keys(body))
      if (key !== 'input') reject('VALIDATION', 'UNKNOWN_FIELD');
    if (
      Buffer.byteLength(JSON.stringify(body), 'utf8') >
      this.options.maxBodyBytes
    )
      reject('PAYLOAD_TOO_LARGE', 'BODY_SIZE');
    return { requestId, identity, input: body['input'] };
  }

  /** Called inside the Nest handler, after guards, interceptors and pipes. */
  async execute(
    instance: object,
    action: ActionDefinition,
    args: unknown[],
    request: object,
  ): Promise<unknown> {
    const admission = admissionFor(request);
    if (!admission || admission.action !== action)
      reject('INTERNAL', 'ADMISSION_REQUIRED');
    const signal = admission.controller.signal;
    if (action.input && action.inputIndex !== undefined) {
      const parsed = await runSchema(action.input, args[action.inputIndex]);
      if (!parsed.ok)
        throw ActionError.validation(undefined, parsed.issues, 'INPUT_SCHEMA');
      args[action.inputIndex] = parsed.value;
    }
    if (signal.aborted) throw abortError(signal.reason);
    const method: unknown = Reflect.get(instance, action.method);
    if (typeof method !== 'function')
      throw new Error(`Server action method ${action.method} is not callable`);
    let result: unknown = await Reflect.apply(method, instance, args);
    if (action.output) {
      const data = result instanceof ActionResult ? result.data : result;
      const parsed = await runSchema(action.output, data);
      if (!parsed.ok)
        throw new ActionError('INTERNAL', undefined, {
          reason: 'OUTPUT_SCHEMA',
          cause: new Error(
            `Output of ${admission.group.id}/${action.id} failed its schema: ${parsed.issues
              .slice(0, 5)
              .map((issue) => `${issue.path.join('.') || '$'} ${issue.message}`)
              .join('; ')}`,
          ),
        });
      result =
        result instanceof ActionResult
          ? result.withData(parsed.value)
          : parsed.value;
    }
    return result;
  }

  #outcome(result: unknown, label: string): StoredActionOutcome {
    if (result instanceof AcceptedJob)
      throw new ActionError('INTERNAL', undefined, {
        reason: 'JOB_NOT_DECLARED',
        cause: new Error(
          `Action ${label} returned acceptJob(...) but is not declared with { job: true }`,
        ),
      });
    const effects = result instanceof ActionResult ? result : undefined;
    const safe = toJsonSafe(effects ? effects.data : result, {
      maxDepth: 64,
      maxNodes: 100_000,
    });
    if (!safe.ok)
      throw new ActionError('INTERNAL', undefined, {
        reason: 'OUTPUT_NOT_JSON_SAFE',
        cause: new Error(
          `Action ${label} returned a value that is not JSON-safe at ${safe.path}: ${safe.problem}. Return plain data, implement toJSON() or map entities to DTO objects.`,
        ),
      });
    if (
      Buffer.byteLength(JSON.stringify(safe.value), 'utf8') >
      this.options.maxOutputBytes
    )
      throw new ActionError('INTERNAL', undefined, {
        reason: 'OUTPUT_TOO_LARGE',
        cause: new Error(
          `Action ${label} output exceeds limits.maxOutputBytes`,
        ),
      });
    return Object.freeze({
      data: safe.value,
      ...(effects?.redirect ? { redirect: effects.redirect } : {}),
      ...(effects && effects.notifications.length > 0
        ? { notifications: effects.notifications }
        : {}),
    });
  }

  /** Queue owner derived from the verified identity only (tenant + subject). */
  #owner(identity: ActionIdentity): ActionJobOwner {
    const custom = this.options.jobOwner;
    if (custom) {
      const owner: unknown = custom(
        Object.freeze({
          subject: identity.subject,
          ...(identity.tenant === undefined ? {} : { tenant: identity.tenant }),
        }),
      );
      const binding: unknown =
        typeof owner === 'object' && owner !== null
          ? Reflect.get(owner, 'binding')
          : undefined;
      if (typeof binding !== 'string' || binding.length === 0)
        throw new Error('jobs.owner must return { binding: non-empty string }');
      return Object.freeze({ binding });
    }
    return Object.freeze({
      binding: createHash('sha256')
        .update(
          ['nestvexa-actions', identity.tenant ?? '', identity.subject].join(
            '\u0000',
          ),
          'utf8',
        )
        .digest('base64url'),
    });
  }

  #snapshot(record: ActionJobRecord): ActionJobSnapshot {
    if (
      typeof record !== 'object' ||
      record === null ||
      typeof record.id !== 'string' ||
      !JOB_ID_PATTERN.test(record.id) ||
      !isActionJobStatus(record.status)
    )
      throw new ActionError('INTERNAL', undefined, {
        reason: 'JOB_RECORD',
        cause: new Error('The job queue returned an invalid job record'),
      });
    const progress =
      typeof record.progress === 'number' && Number.isFinite(record.progress)
        ? Math.max(0, Math.min(100, Math.round(record.progress)))
        : 0;
    let result: JsonValue | null = null;
    if (record.status === 'succeeded') {
      const safe = toJsonSafe(record.result ?? null, {
        maxDepth: 64,
        maxNodes: 100_000,
      });
      result = safe.ok ? safe.value : null;
    }
    return Object.freeze({
      id: record.id,
      status: record.status,
      progress,
      result,
      error:
        record.status === 'failed'
          ? typeof record.error === 'string' && record.error.length > 0
            ? record.error.slice(0, MAX_MESSAGE_LENGTH)
            : DEFAULT_ERROR_MESSAGES.INTERNAL
          : null,
    });
  }

  /** Enqueues an accepted job for the caller and builds its 202 ticket. */
  async #accept(
    result: unknown,
    context: { readonly identity: ActionIdentity },
    label: string,
  ): Promise<StoredActionOutcome> {
    if (!(result instanceof AcceptedJob))
      throw new ActionError('INTERNAL', undefined, {
        reason: 'JOB_REQUIRED',
        cause: new Error(
          `Job action ${label} must return acceptJob(name, handler)`,
        ),
      });
    const queue = this.options.jobQueue;
    if (!queue)
      throw new ActionError('INTERNAL', undefined, {
        status: 503,
        reason: 'JOBS_UNAVAILABLE',
        cause: new Error(
          `Job action ${label} requires the ActionsModule jobs.queue host option`,
        ),
      });
    const accepted: AcceptedJob<unknown> = result;
    const maxOutputBytes = this.options.maxOutputBytes;
    // The job result is held to the same JSON-safety and size rules as data.
    const handler = async (job: Parameters<typeof accepted.handler>[0]) => {
      const value = await accepted.handler(job);
      const safe = toJsonSafe(value, { maxDepth: 64, maxNodes: 100_000 });
      if (!safe.ok)
        throw new Error(
          `Job ${accepted.name} returned a value that is not JSON-safe at ${safe.path}`,
        );
      if (
        Buffer.byteLength(JSON.stringify(safe.value), 'utf8') > maxOutputBytes
      )
        throw new Error(`Job ${accepted.name} result exceeds maxOutputBytes`);
      return safe.value;
    };
    const record = await queue.enqueue(
      this.#owner(context.identity),
      accepted.name,
      handler,
      accepted.maxAttempts === undefined
        ? undefined
        : { maxAttempts: accepted.maxAttempts },
    );
    const snapshot = this.#snapshot(record);
    const channel = this.options.jobChannel?.(snapshot.id);
    if (channel !== undefined && (typeof channel !== 'string' || !channel))
      throw new Error('jobs.channel must return a non-empty string');
    const job: ActionJobTicket = Object.freeze({
      id: snapshot.id,
      status: snapshot.status,
      progress: snapshot.progress,
      pollAfterMs: this.options.jobPollAfterMs,
      ...(channel === undefined ? {} : { stream: Object.freeze({ channel }) }),
    });
    return Object.freeze({ data: null, job });
  }

  /**
   * `<prefix>/_jobs/status` and `/_jobs/cancel`: the same admission as
   * actions (origin, CSRF, identity, rate limit, body shape), host
   * `authorize` with group `_jobs`, then owner-bound queue access. Another
   * owner's job id is indistinguishable from an unknown one (404).
   */
  async job(
    request: object,
    response: unknown,
    operation: 'status' | 'cancel',
  ): Promise<ActionSuccessEnvelope> {
    const descriptor: ActionDescriptor = Object.freeze({
      group: JOBS_SEGMENT,
      action: operation,
      version: null,
      idempotent: false,
    });
    this.#observe(request, response, descriptor);
    const { requestId, identity, input } = await this.#gate(
      request,
      response,
      descriptor,
    );
    await this.#authorize(identity, descriptor, request);
    const queue = this.options.jobQueue;
    if (!queue) reject('NOT_FOUND', 'JOBS_UNAVAILABLE');
    if (
      !plainObject(input) ||
      Object.keys(input).some((key) => key !== 'id') ||
      typeof input['id'] !== 'string' ||
      !JOB_ID_PATTERN.test(input['id'])
    )
      throw ActionError.validation(
        undefined,
        [{ path: ['id'], message: 'A job id is required' }],
        'JOB_ID',
      );
    const id = input['id'];
    const observation = observations.get(request);
    if (observation) observation.jobId = id;
    const owner = this.#owner(identity);
    if (operation === 'cancel') {
      const cancel = queue.cancel;
      if (typeof cancel !== 'function')
        reject('CONFLICT', 'JOB_NOT_CANCELLABLE');
      const cancelled =
        (await Reflect.apply(cancel, queue, [owner, id])) === true;
      const record = await queue.get(owner, id);
      if (!record) reject('NOT_FOUND', 'JOB_NOT_FOUND');
      const job = this.#snapshot(record) as unknown as JsonValue;
      return this.#completed(request, { data: { cancelled, job } }, requestId);
    }
    const record = await queue.get(owner, id);
    if (!record) reject('NOT_FOUND', 'JOB_NOT_FOUND');
    return this.#completed(
      request,
      { data: this.#snapshot(record) as unknown as JsonValue },
      requestId,
    );
  }

  #observe(
    request: object,
    response: unknown,
    descriptor: ActionDescriptor,
  ): void {
    const { instrumentation, logger } = this.options;
    if ((!instrumentation && !logger) || observations.has(request)) return;
    const requestId = requestIdFor(request);
    const attributes: ActionSpanAttributes = {
      'nestvexa.action.group': descriptor.group,
      'nestvexa.action.id': descriptor.action,
      ...(descriptor.version === null
        ? {}
        : { 'nestvexa.action.version': descriptor.version }),
      'nestvexa.request_id': requestId,
    };
    let span: ActionSpan | undefined;
    try {
      span = instrumentation?.start('nestvexa.action', attributes);
    } catch {
      // Telemetry must never fail the call.
      span = undefined;
    }
    const raw = rawResponse(response);
    const observation: Observation = {
      descriptor,
      requestId,
      started: performance.now(),
      span,
      streamed: raw !== undefined,
      replayed: false,
      ended: false,
    };
    observations.set(request, observation);
    if (!raw) return;
    const done = () => {
      raw.off('finish', done);
      raw.off('close', done);
      // A response closed before it finished means the client went away.
      this.#finish(
        observation,
        raw.writableFinished === false ? 499 : (raw.statusCode ?? 200),
      );
    };
    raw.on('finish', done);
    raw.on('close', done);
  }

  #finish(observation: Observation, status: number): void {
    if (observation.ended) return;
    observation.ended = true;
    const failed = status >= 400;
    const code: ActionCallLog['code'] = failed
      ? (observation.code ??
        (status === 499 ? 'TIMEOUT' : codeForStatus(status)))
      : status === 202
        ? 'ACCEPTED'
        : 'OK';
    const reason =
      observation.reason ?? (status === 499 ? 'CLIENT_CLOSED' : undefined);
    const durationMs =
      Math.round((performance.now() - observation.started) * 1000) / 1000;
    try {
      observation.span?.end(failed ? 'error' : 'ok', {
        'http.status_code': status,
        'nestvexa.action.code': code,
        'nestvexa.action.replayed': observation.replayed,
        ...(reason === undefined ? {} : { 'nestvexa.action.reason': reason }),
        ...(observation.jobId === undefined
          ? {}
          : { 'nestvexa.job.id': observation.jobId }),
      });
    } catch {
      // Telemetry must never fail the call.
    }
    const logger = this.options.logger;
    if (!logger) return;
    const record: ActionCallLog = {
      requestId: observation.requestId,
      group: observation.descriptor.group,
      action: observation.descriptor.action,
      version: observation.descriptor.version,
      status,
      code,
      ...(reason === undefined ? {} : { reason }),
      durationMs,
      replayed: observation.replayed,
      ...(observation.jobId === undefined ? {} : { jobId: observation.jobId }),
    };
    try {
      if (status >= 500) logger.error('nestvexa.action', { ...record });
      else if (failed) logger.warn('nestvexa.action', { ...record });
      else logger.info('nestvexa.action', { ...record });
    } catch {
      // Logging must never fail the call.
    }
  }

  #idempotencyKey(
    identity: ActionIdentity,
    descriptor: ActionDescriptor,
    key: string,
  ): string {
    return createHash('sha256')
      .update(
        [
          identity.tenant ?? '',
          identity.subject,
          descriptor.group,
          descriptor.action,
          String(descriptor.version ?? 0),
          key,
        ].join('\u0000'),
        'utf8',
      )
      .digest('hex');
  }

  /**
   * Runs as the outermost class interceptor: deadline and cancellation,
   * serial dispatch, idempotent replay and JSON-safe envelope creation around
   * the application's interceptors, pipes and handler.
   */
  async run(
    request: object,
    response: unknown,
    invoke: () => Promise<unknown>,
  ): Promise<ActionSuccessEnvelope> {
    const admission = admissionFor(request);
    if (!admission) reject('INTERNAL', 'ADMISSION_REQUIRED');
    const { action, context, controller, group } = admission;
    const label = `${group.id}/${action.id}`;
    const signal = controller.signal;
    const aborted = new Promise<never>((_resolve, rejectAbort) => {
      const fail = () => rejectAbort(abortError(signal.reason));
      if (signal.aborted) fail();
      else signal.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => undefined);
    const timer = setTimeout(
      () => controller.abort(abortReason('timeout')),
      action.timeoutMs ?? this.options.timeoutMs,
    );
    const raw = rawResponse(response);
    const onClose = () => {
      if (raw && !raw.writableEnded)
        controller.abort(abortReason('disconnect'));
    };
    raw?.on('close', onClose);
    this.#inflight.add(controller);
    let release: (() => void) | undefined;
    let pendingKey: string | undefined;
    try {
      if (action.idempotent && context.idempotencyKey !== undefined) {
        const key = this.#idempotencyKey(
          context.identity,
          context.action,
          context.idempotencyKey,
        );
        const fingerprint = createHash('sha256')
          .update(
            stableStringify(admission.input as JsonValue | undefined),
            'utf8',
          )
          .digest('hex');
        // Not raced against the deadline: a lost `started` result would leave
        // the key in progress until its TTL.
        const begun = await this.#store.begin(
          key,
          fingerprint,
          this.options.idempotencyTtlMs,
        );
        if (begun.status === 'replay') {
          this.setHeader(response, REPLAYED_HEADER, 'true');
          const observation = observations.get(request);
          if (observation) {
            observation.replayed = true;
            if (begun.outcome.job) observation.jobId = begun.outcome.job.id;
          }
          return this.#completed(request, begun.outcome, context.requestId);
        }
        if (begun.status === 'in-progress')
          reject('CONFLICT', 'IDEMPOTENCY_IN_PROGRESS');
        if (begun.status === 'mismatch')
          reject('CONFLICT', 'IDEMPOTENCY_MISMATCH');
        if (begun.status === 'full')
          reject('RATE_LIMITED', 'IDEMPOTENCY_CAPACITY');
        pendingKey = key;
        if (signal.aborted) throw abortError(signal.reason);
      }
      // The serial lock comes after the idempotency check: a duplicate of a
      // running call is rejected with 409 instead of queueing behind it.
      if (action.concurrency === 'serial') {
        release = await this.#mutex.acquire(
          `${context.identity.tenant ?? ''}\u0000${context.identity.subject}\u0000${group.id}`,
          signal,
        );
        if (signal.aborted) throw abortError(signal.reason);
      }
      const ownedRelease = release;
      const ownedKey = pendingKey;
      release = undefined;
      pendingKey = undefined;
      // Locks and idempotency records follow the real work, not the HTTP
      // response: a timed-out call keeps them until the handler settles.
      const settled = (async () => {
        try {
          const value = await invoke();
          const outcome = action.job
            ? await this.#accept(value, context, label)
            : this.#outcome(value, label);
          if (ownedKey !== undefined)
            await this.#store.complete(ownedKey, outcome);
          return outcome;
        } catch (error) {
          if (ownedKey !== undefined) await this.#store.abandon(ownedKey);
          throw error;
        } finally {
          ownedRelease?.();
        }
      })();
      settled.catch(() => undefined);
      return this.#completed(
        request,
        await Promise.race([settled, aborted]),
        context.requestId,
      );
    } finally {
      clearTimeout(timer);
      raw?.off('close', onClose);
      this.#inflight.delete(controller);
      release?.();
      if (pendingKey !== undefined) await this.#store.abandon(pendingKey);
    }
  }

  /** Success envelope; ends the observation when no response stream reports it. */
  #completed(
    request: object,
    outcome: StoredActionOutcome,
    requestId: string,
  ): ActionSuccessEnvelope {
    const observation = observations.get(request);
    if (observation) {
      if (outcome.job) observation.jobId = outcome.job.id;
      if (!observation.streamed)
        this.#finish(observation, outcome.job ? 202 : 200);
    }
    return this.#success(outcome, requestId);
  }

  #success(
    outcome: StoredActionOutcome,
    requestId: string,
  ): ActionSuccessEnvelope {
    return {
      protocol: ACTIONS_PROTOCOL,
      ok: true,
      requestId,
      data: outcome.data,
      ...(outcome.redirect ? { redirect: outcome.redirect } : {}),
      ...(outcome.notifications
        ? { notifications: outcome.notifications }
        : {}),
      ...(outcome.job ? { job: outcome.job } : {}),
    };
  }

  /** Maps any exception to a status and public error body without leaking internals. */
  describe(exception: unknown): DescribedError {
    const expose = this.options.exposeErrorDetails;
    const detail = (error: unknown) => {
      if (!expose) return {};
      const source =
        error instanceof ActionError && error.cause !== undefined
          ? error.cause
          : error;
      return source instanceof Error
        ? { detail: source.message.slice(0, MAX_MESSAGE_LENGTH) }
        : {};
    };
    if (exception instanceof ActionError) {
      const status = exception.getStatus();
      return {
        status,
        body: {
          code: exception.code,
          message: exception.message,
          ...(exception.reason === undefined
            ? {}
            : { reason: exception.reason }),
          ...(exception.issues === undefined
            ? {}
            : { issues: exception.issues }),
          ...(status >= 500 ? detail(exception) : {}),
        },
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code: ActionErrorCode = codeForStatus(status);
      if (status >= 500)
        return {
          status,
          body: {
            code,
            message: DEFAULT_ERROR_MESSAGES[code],
            ...detail(exception),
          },
        };
      // 4xx HttpException messages are public in Nest; keep them, bounded.
      const response: unknown = exception.getResponse();
      const raw: unknown =
        typeof response === 'string'
          ? response
          : typeof response === 'object' && response !== null
            ? Reflect.get(response, 'message')
            : undefined;
      let issues: readonly ActionIssue[] | undefined;
      let message = DEFAULT_ERROR_MESSAGES[code];
      if (Array.isArray(raw) && raw.every((entry) => typeof entry === 'string'))
        issues = sanitizeIssues(
          raw.map((entry: string) => ({ path: [], message: entry })),
        );
      else if (typeof raw === 'string' && raw.length > 0)
        message = raw.slice(0, MAX_MESSAGE_LENGTH);
      return {
        status,
        body: { code, message, ...(issues ? { issues } : {}) },
      };
    }
    return {
      status: 500,
      body: {
        code: 'INTERNAL',
        message: DEFAULT_ERROR_MESSAGES.INTERNAL,
        ...detail(exception),
      },
    };
  }

  failure(requestId: string, body: ActionErrorBody): ActionFailureEnvelope {
    return { protocol: ACTIONS_PROTOCOL, ok: false, requestId, error: body };
  }

  report(request: object, exception: unknown, described: DescribedError): void {
    const observation = observations.get(request);
    if (observation) {
      observation.code = described.body.code;
      if (described.body.reason !== undefined)
        observation.reason = described.body.reason;
      if (!observation.streamed) this.#finish(observation, described.status);
    }
    const admission = admissionFor(request);
    const event = Object.freeze({
      requestId: requestIdFor(request),
      action: admission ? this.descriptor(admission.action) : undefined,
      code: described.body.code,
      status: described.status,
      error: exception,
    });
    try {
      if (this.options.onError) this.options.onError(event);
      else if (described.status >= 500)
        this.#logger.error(
          `Server action ${event.action ? `${event.action.group}/${event.action.action}` : '(not admitted)'} failed [${event.requestId}] ${event.code}`,
          exception instanceof Error ? exception.stack : undefined,
        );
    } catch {
      // Observability hooks must never replace the client response.
    }
  }

  beforeApplicationShutdown(): void {
    this.#closed = true;
    for (const controller of this.#inflight)
      controller.abort(abortReason('shutdown'));
  }

  async onApplicationShutdown(): Promise<void> {
    this.#closed = true;
    this.registry.release(this);
    this.#mutex.clear();
    this.#rateLimit?.clear?.();
    if (this.#ownsStore) await this.#store.clear?.();
  }
}
