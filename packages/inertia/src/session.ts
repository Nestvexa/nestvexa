/**
 * Host-owned session access. The adapter never creates, signs or persists a
 * session; it only reads and writes its own namespaced keys on the session the
 * host attached to the request (for example `express-session` or
 * `@fastify/session`). Values must be JSON-compatible.
 */
export interface InertiaSessionAdapter {
  /** Whether the request carries a usable session. */
  available(request: object): boolean;
  get(request: object, key: string): unknown;
  set(request: object, key: string, value: unknown): void;
  delete(request: object, key: string): void;
}

interface MethodSession {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

function sessionOf(request: object): object | undefined {
  const session: unknown = (request as { session?: unknown }).session;
  return typeof session === 'object' && session !== null ? session : undefined;
}

function hasMethods(session: object): session is MethodSession {
  const candidate = session as { get?: unknown; set?: unknown };
  return (
    typeof candidate.get === 'function' && typeof candidate.set === 'function'
  );
}

/**
 * Default adapter for `request.session`: uses `get`/`set` when the session
 * object exposes them (`@fastify/session`) and own data properties otherwise
 * (`express-session`). Deleting writes `undefined` through `set` for method
 * sessions so the store observes the change.
 */
export const requestSessionAdapter: InertiaSessionAdapter = Object.freeze({
  available(request: object): boolean {
    return sessionOf(request) !== undefined;
  },
  get(request: object, key: string): unknown {
    const session = sessionOf(request);
    if (!session) return undefined;
    if (hasMethods(session)) return session.get(key);
    return Object.hasOwn(session, key)
      ? (session as Record<string, unknown>)[key]
      : undefined;
  },
  set(request: object, key: string, value: unknown): void {
    const session = sessionOf(request);
    if (!session) return;
    if (hasMethods(session)) session.set(key, value);
    else
      Object.defineProperty(session, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
  },
  delete(request: object, key: string): void {
    const session = sessionOf(request);
    if (!session) return;
    if (hasMethods(session)) session.set(key, undefined);
    else delete (session as Record<string, unknown>)[key];
  },
});

/** Reads and removes a key: the read-once primitive behind flash and errors. */
export function pull(
  adapter: InertiaSessionAdapter,
  request: object,
  key: string,
): unknown {
  if (!adapter.available(request)) return undefined;
  const value = adapter.get(request, key);
  if (value !== undefined) adapter.delete(request, key);
  return value;
}
