import { createHash } from 'node:crypto';
import { LiveProtocolError } from './protocol.js';
import type { JsonValue, LiveRequest } from './protocol.js';

const replayLifetime = 300_000;
const maxReplays = 1_000;
const maxLocks = 10_000;

function digest(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}
/** Deterministic JSON with sorted keys, used only for fingerprints. */
function canonical(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + canonical(value[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

/**
 * Bounded single-process store of committed idempotent responses. Keys bind
 * the identity, state reference and request ID; the fingerprint binds the
 * component, action, revision, updates and input of the original request.
 */
export class ActionReplayCache {
  readonly #entries = new Map<
    string,
    {
      readonly fingerprint: string;
      readonly response: object;
      expiresAt: number;
    }
  >();

  constructor(private readonly now: () => number = Date.now) {}

  #key(binding: string, payload: LiveRequest): string {
    return digest(
      `${binding}\u0000${payload.snapshot}\u0000${payload.requestId}`,
    );
  }
  #fingerprint(
    component: string,
    action: string,
    payload: LiveRequest,
  ): string {
    return digest(
      canonical({
        component,
        action,
        revision: payload.revision,
        updates: payload.updates,
        input: payload.input ?? null,
      }),
    );
  }
  #prune(): void {
    const now = this.now();
    for (const [key, entry] of this.#entries)
      if (entry.expiresAt <= now) this.#entries.delete(key);
  }

  /** Stored response for an identical retry; throws for a reused ID with another payload. */
  lookup(
    binding: string,
    component: string,
    action: string,
    payload: LiveRequest,
  ): object | undefined {
    this.#prune();
    const entry = this.#entries.get(this.#key(binding, payload));
    if (!entry) return undefined;
    if (entry.fingerprint !== this.#fingerprint(component, action, payload))
      throw new LiveProtocolError(
        'IDEMPOTENCY_CONFLICT',
        422,
        'Live request ID was reused with a different payload',
      );
    return entry.response;
  }

  remember(
    binding: string,
    component: string,
    action: string,
    payload: LiveRequest,
    response: object,
  ): void {
    this.#prune();
    // Oldest-first eviction: an evicted retry fails safely with STALE_REVISION.
    while (this.#entries.size >= maxReplays) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
    this.#entries.set(this.#key(binding, payload), {
      fingerprint: this.#fingerprint(component, action, payload),
      response: Object.freeze({ ...response, replayed: true }),
      expiresAt: this.now() + replayLifetime,
    });
  }

  clear(): void {
    this.#entries.clear();
  }
}

/** Identity-scoped exclusive action locks; overlapping calls are rejected, never queued. */
export class ActionLocks {
  readonly #held = new Set<string>();

  acquire(binding: string, component: string, action: string): () => void {
    const key = digest(`${binding}\u0000${component}\u0000${action}`);
    if (this.#held.has(key))
      throw new LiveProtocolError(
        'ACTION_BUSY',
        409,
        'This action is already running for the current identity',
      );
    if (this.#held.size >= maxLocks)
      throw new LiveProtocolError(
        'STORE_CAPACITY',
        503,
        'Live action capacity reached',
      );
    this.#held.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#held.delete(key);
    };
  }

  get size(): number {
    return this.#held.size;
  }
}
