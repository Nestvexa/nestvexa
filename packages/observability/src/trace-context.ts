import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/) for inbound
 * requests. Browsers do not send `traceparent` by themselves: it arrives from
 * a browser OpenTelemetry SDK (fetch/XHR instrumentation), a proxy or another
 * service. Everything here treats the header as untrusted input: strict
 * grammar, bounded length, never echoed, and `tracestate` dropped unless the
 * host opts in.
 */
export interface TraceContext {
  /** 32 lowercase hex characters, not all zero. */
  readonly traceId: string;
  /** The caller's span id: 16 lowercase hex characters, not all zero. */
  readonly parentId: string;
  /** The caller's sampled flag (bit 0 of trace-flags). */
  readonly sampled: boolean;
  /** Present only when `keepTraceState` is enabled and the value is valid. */
  readonly traceState?: string;
}

const traceparent =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const zeroTrace = '0'.repeat(32);
const zeroSpan = '0'.repeat(16);
// tracestate list members: key=value, keys per the W3C grammar, bounded.
const traceStateMember =
  /^(?:[a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})=[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/;

/** Parse a `traceparent` header value; malformed values return undefined. */
export function parseTraceparent(value: unknown): TraceContext | undefined {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  const match = traceparent.exec(value.trim());
  if (!match) return undefined;
  const [, version = '', traceId = '', parentId = '', flags = '', rest] = match;
  // Version ff is forbidden; version 00 has no trailing fields. Future
  // versions may append fields after a dash, which are ignored.
  if (version === 'ff' || (version === '00' && rest !== undefined))
    return undefined;
  if (traceId === zeroTrace || parentId === zeroSpan) return undefined;
  return Object.freeze({
    traceId,
    parentId,
    sampled: (Number.parseInt(flags, 16) & 1) === 1,
  });
}

/** Validate a `tracestate` value: at most 32 well-formed members, 512 chars. */
export function parseTraceState(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512)
    return undefined;
  const members = value
    .split(',')
    .map((member) => member.trim())
    .filter(Boolean);
  if (members.length === 0 || members.length > 32) return undefined;
  return members.every((member) => traceStateMember.test(member))
    ? members.join(',')
    : undefined;
}

/** Serialize a span as a version-00 `traceparent` for outbound calls. */
export function formatTraceparent(context: {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
}): string {
  if (
    !/^[0-9a-f]{32}$/.test(context.traceId) ||
    context.traceId === zeroTrace ||
    !/^[0-9a-f]{16}$/.test(context.spanId) ||
    context.spanId === zeroSpan
  )
    throw new Error('Invalid trace or span id');
  return `00-${context.traceId}-${context.spanId}-${context.sampled ? '01' : '00'}`;
}

function header(request: object, name: string): string | undefined {
  const headers: unknown = Reflect.get(request, 'headers');
  if (headers === null || typeof headers !== 'object') return undefined;
  const value: unknown = Reflect.get(headers, name);
  // Duplicate traceparent headers are ambiguous and therefore ignored.
  return typeof value === 'string' ? value : undefined;
}

export interface TraceContextOptions {
  /**
   * Decide whether a request's inbound context is accepted (for example only
   * from your own origin or internal network). Default: accept any
   * well-formed header. Rejected requests start a new trace.
   */
  readonly trust?: (request: object) => boolean;
  /** Keep a validated `tracestate`. Default false (vendor data is dropped). */
  readonly keepTraceState?: boolean;
}

/** Read the inbound trace context of an Express or Fastify request. */
export function readTraceContext(
  request: object,
  options: TraceContextOptions = {},
): TraceContext | undefined {
  if (options.trust && !options.trust(request)) return undefined;
  const context = parseTraceparent(header(request, 'traceparent'));
  if (!context || !options.keepTraceState) return context;
  const state = parseTraceState(header(request, 'tracestate'));
  return state === undefined
    ? context
    : Object.freeze({ ...context, traceState: state });
}

const storage = new AsyncLocalStorage<TraceContext | undefined>();

/** The inbound trace context of the request currently being handled. */
export function currentTraceContext(): TraceContext | undefined {
  return storage.getStore();
}
/** Run work with an explicit trace context (tests, jobs, custom transports). */
export function runWithTraceContext<T>(
  context: TraceContext | undefined,
  work: () => T,
): T {
  return storage.run(context, work);
}

/**
 * Connect-style middleware (`app.use(...)` with Express, or Fastify through
 * Nest's middleware support) that makes the request's validated inbound trace
 * context available to instrumentation for the rest of the request.
 */
export function traceContextMiddleware(
  options: TraceContextOptions = {},
): (request: object, response: unknown, next: () => void) => void {
  return (request, _response, next) => {
    let context: TraceContext | undefined;
    try {
      context = readTraceContext(request, options);
    } catch {
      // A throwing trust policy never breaks the request; it starts a new trace.
      context = undefined;
    }
    storage.run(context, next);
  };
}
