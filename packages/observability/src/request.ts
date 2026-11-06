import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { LiveInstrumentation, LiveSpan } from './instrumentation.js';

/**
 * Request admission tracing: a request id per request (generated, or an
 * inbound `x-request-id` the host explicitly trusts), echoed in the response
 * and attached to every span recorded by `MemoryInstrumentation`, plus a
 * `nestvexa.request` span with the method, status and response size. Paths,
 * query strings, headers and bodies are never recorded.
 */
export interface RequestTracingOptions {
  /**
   * Accept an inbound `x-request-id` (for example from your own proxy) when
   * this returns true. Default: never; every request gets a fresh id.
   */
  readonly trustRequestId?: (request: object) => boolean;
  /** Echo the id as `X-Request-Id`. Default true. */
  readonly responseHeader?: boolean;
}

const storage = new AsyncLocalStorage<string | undefined>();
const requestIdPattern = /^[A-Za-z0-9._:-]{8,64}$/;
const methods = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

/** The id of the request currently being handled (see `requestTracingMiddleware`). */
export function currentRequestId(): string | undefined {
  return storage.getStore();
}
/** Run work with an explicit request id (tests, jobs, custom transports). */
export function runWithRequestId<T>(
  requestId: string | undefined,
  work: () => T,
): T {
  return storage.run(requestId, work);
}

interface RawRequest {
  readonly method?: unknown;
  readonly headers?: unknown;
}
interface RawResponse {
  statusCode?: unknown;
  setHeader?(name: string, value: string): unknown;
  getHeader?(name: string): unknown;
  once?(event: string, listener: () => void): unknown;
}
function inboundId(request: RawRequest): string | undefined {
  const headers = request.headers;
  if (headers === null || typeof headers !== 'object') return undefined;
  const value: unknown = Reflect.get(headers, 'x-request-id');
  return typeof value === 'string' && requestIdPattern.test(value)
    ? value
    : undefined;
}

/**
 * Connect-style middleware (`app.use(...)` on Express, or Fastify through
 * Nest's middleware support). Register it first so every later span carries
 * the request id.
 */
export function requestTracingMiddleware(
  instrumentation?: LiveInstrumentation,
  options: RequestTracingOptions = {},
): (request: object, response: unknown, next: () => void) => void {
  return (request, response, next) => {
    const raw = request as RawRequest;
    const reply = (
      typeof response === 'object' && response !== null ? response : {}
    ) as RawResponse;
    let trusted: boolean;
    try {
      trusted = options.trustRequestId?.(request) === true;
    } catch {
      // A throwing trust policy never breaks the request.
      trusted = false;
    }
    const requestId = (trusted ? inboundId(raw) : undefined) ?? randomUUID();
    if (options.responseHeader !== false && reply.setHeader)
      try {
        reply.setHeader('X-Request-Id', requestId);
      } catch {
        // Headers may already be sent by an earlier middleware.
      }
    storage.run(requestId, () => {
      let span: LiveSpan | undefined;
      try {
        span = instrumentation?.start('nestvexa.request', {
          'nestvexa.http.method':
            typeof raw.method === 'string' && methods.has(raw.method)
              ? raw.method
              : 'OTHER',
        });
      } catch {
        span = undefined;
      }
      if (span && reply.once) {
        const active = span;
        let ended = false;
        const finish = (aborted: boolean) => {
          if (ended) return;
          ended = true;
          const status =
            typeof reply.statusCode === 'number' ? reply.statusCode : 0;
          const length: unknown = reply.getHeader?.('content-length');
          const bytes = Number(length);
          try {
            active.end(aborted || status >= 500 ? 'error' : 'ok', {
              'nestvexa.http.status': status,
              ...(Number.isSafeInteger(bytes) && bytes >= 0
                ? { 'nestvexa.http.response_bytes': bytes }
                : {}),
              ...(aborted ? { 'nestvexa.http.aborted': true } : {}),
            });
          } catch {
            // Telemetry is best effort.
          }
        };
        reply.once('finish', () => finish(false));
        reply.once('close', () => finish(true));
      }
      next();
    });
  };
}
