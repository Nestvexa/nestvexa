import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Uniform access to a host session (express-session style or get/set style). */
export interface SessionAccess {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

/**
 * Read the host session from `request.session`. Property-bag sessions
 * (express-session, most Fastify session plugins) and sessions exposing
 * `get`/`set` methods (`@fastify/secure-session`) are supported. Returns
 * `undefined` when the host installed no session middleware.
 */
export function sessionOf(request: object): SessionAccess | undefined {
  const session: unknown = Reflect.get(request, 'session');
  if (session === null || typeof session !== 'object') return undefined;
  const get: unknown = Reflect.get(session, 'get');
  const set: unknown = Reflect.get(session, 'set');
  if (typeof get === 'function' && typeof set === 'function')
    return {
      get: (key) => Reflect.apply(get, session, [key]) as unknown,
      set: (key, value) => {
        Reflect.apply(set, session, [key, value]);
      },
      delete: (key) => {
        Reflect.apply(set, session, [key, undefined]);
      },
    };
  return {
    get: (key) => {
      const descriptor = Object.getOwnPropertyDescriptor(session, key);
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    },
    set: (key, value) => {
      Reflect.set(session, key, value);
    },
    delete: (key) => {
      Reflect.deleteProperty(session, key);
    },
  };
}

function requireSession(request: object): SessionAccess {
  const session = sessionOf(request);
  if (!session)
    throw new Error(
      'This form helper requires host session middleware (request.session)',
    );
  return session;
}

export interface CsrfOptions {
  /** Session property holding the token. Default `csrf` (shared with the Live identity in the starters). */
  readonly sessionKey?: string;
  /** Hidden form field carrying the token. Default `_csrf`. */
  readonly field?: string;
  /** Optional request header accepted instead of the field. Default `x-csrf-token`. */
  readonly header?: string;
}
const tokenPattern = /^[A-Za-z0-9_-]{32,256}$/;
function settings(options: CsrfOptions = {}) {
  const sessionKey = options.sessionKey ?? 'csrf';
  const field = options.field ?? '_csrf';
  const header = (options.header ?? 'x-csrf-token').toLowerCase();
  for (const value of [sessionKey, field])
    if (!/^[A-Za-z_][A-Za-z0-9_:-]{0,63}$/.test(value))
      throw new Error('Invalid CSRF option name');
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(header))
    throw new Error('Invalid CSRF header name');
  return { sessionKey, field, header };
}

/**
 * Return the session's CSRF token, creating a 256-bit random token when absent.
 * Render it in a hidden `_csrf` field of every state-changing form.
 */
export function csrfToken(request: object, options: CsrfOptions = {}): string {
  const { sessionKey } = settings(options);
  const session = requireSession(request);
  const current = session.get(sessionKey);
  if (typeof current === 'string' && tokenPattern.test(current)) return current;
  const token = randomBytes(32).toString('base64url');
  session.set(sessionKey, token);
  return token;
}

/** Replace the session's CSRF token (for example after login). */
export function rotateCsrfToken(
  request: object,
  options: CsrfOptions = {},
): string {
  const { sessionKey } = settings(options);
  const token = randomBytes(32).toString('base64url');
  requireSession(request).set(sessionKey, token);
  return token;
}

/** Constant-time string comparison (length is not secret). */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bodyValue(request: object, field: string): unknown {
  const body: unknown = Reflect.get(request, 'body');
  if (body === null || typeof body !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(body, field);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
export function headerValue(request: object, name: string): string | undefined {
  const headers: unknown = Reflect.get(request, 'headers');
  if (headers === null || typeof headers !== 'object') return undefined;
  const value: unknown = Reflect.get(headers, name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Compare the submitted token (hidden field, else header) with the session
 * token in constant time. Fails closed: no session, no token, a malformed
 * token or an array of tokens all return false.
 */
export function verifyCsrf(
  request: object,
  options: CsrfOptions = {},
): boolean {
  const { sessionKey, field, header } = settings(options);
  const session = sessionOf(request);
  if (!session) return false;
  const expected = session.get(sessionKey);
  if (typeof expected !== 'string' || !tokenPattern.test(expected))
    return false;
  const submitted = bodyValue(request, field) ?? headerValue(request, header);
  if (typeof submitted !== 'string' || submitted.length > 256) return false;
  return constantTimeEqual(submitted, expected);
}

const flashKey = 'nestvexa:flash';
const maxFlash = 8;
/**
 * Append a flash message (1–500 characters) for the next page. It uses the same
 * session key as `flashLive`, so `consumeLiveFlash(request)` and
 * {@link consumeFlash} read both sources.
 */
export function pushFlash(request: object, message: string): void {
  if (typeof message !== 'string' || !message || message.length > 500)
    throw new Error('Flash messages are 1–500 characters');
  const session = requireSession(request);
  const prior = session.get(flashKey);
  const list = Array.isArray(prior)
    ? prior.filter((item): item is string => typeof item === 'string')
    : [];
  session.set(flashKey, [...list, message].slice(-maxFlash));
}
/** Read and remove pending flash messages. */
export function consumeFlash(request: object): readonly string[] {
  const session = sessionOf(request);
  if (!session) return Object.freeze([]);
  const prior = session.get(flashKey);
  session.delete(flashKey);
  return Object.freeze(
    Array.isArray(prior)
      ? prior
          .filter((item): item is string => typeof item === 'string')
          .slice(-maxFlash)
      : [],
  );
}
