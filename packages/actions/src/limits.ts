import { ActionError } from './errors.js';
import type { ActionDescriptor } from './metadata.js';
import type { ActionIdentity } from './state.js';

export interface ActionRateLimitContext {
  readonly identity: ActionIdentity;
  readonly action: ActionDescriptor;
  readonly request: object;
}
/** Return `false` to reject with RATE_LIMITED (429). */
export type ActionRateLimit = (
  context: ActionRateLimitContext,
) => boolean | Promise<boolean>;

export interface FixedWindowRateLimitOptions {
  /** Requests allowed per key and window, default 120. */
  readonly limit?: number;
  /** Window length in milliseconds, default 60000. */
  readonly windowMs?: number;
  /** Maximum tracked keys; new keys are rejected when full, default 10000. */
  readonly maxKeys?: number;
  /** Key derivation, default `${tenant}\0${subject}`. */
  readonly key?: (context: ActionRateLimitContext) => string;
  readonly now?: () => number;
}

/** Process-local fixed window limiter. Use a shared store hook for multi-instance hosts. */
export function createFixedWindowRateLimit(
  options: FixedWindowRateLimitOptions = {},
): ActionRateLimit & { clear(): void } {
  const limit = options.limit ?? 120;
  const windowMs = options.windowMs ?? 60_000;
  const maxKeys = options.maxKeys ?? 10_000;
  for (const [name, value] of [
    ['limit', limit],
    ['windowMs', windowMs],
    ['maxKeys', maxKeys],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`Rate limit ${name} must be a positive integer`);
  const now = options.now ?? Date.now;
  const key =
    options.key ??
    ((context: ActionRateLimitContext) =>
      `${context.identity.tenant ?? ''}\u0000${context.identity.subject}`);
  const buckets = new Map<string, { start: number; count: number }>();
  const consume = (context: ActionRateLimitContext): boolean => {
    const time = now();
    const id = key(context);
    let bucket = buckets.get(id);
    if (bucket && time - bucket.start >= windowMs) {
      buckets.delete(id);
      bucket = undefined;
    }
    if (!bucket) {
      if (buckets.size >= maxKeys)
        for (const [candidate, value] of buckets)
          if (time - value.start >= windowMs) buckets.delete(candidate);
      if (buckets.size >= maxKeys) return false;
      bucket = { start: time, count: 0 };
      buckets.set(id, bucket);
    }
    bucket.count++;
    return bucket.count <= limit;
  };
  return Object.assign(consume, { clear: () => buckets.clear() });
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Keyed FIFO mutex for `serial` actions. Waiting is bounded per key and
 * abortable; the lock is held until the underlying handler settles, even when
 * the HTTP response already reported a timeout.
 */
export class KeyedMutex {
  readonly #entries = new Map<string, Waiter[]>();
  readonly #maxWaiters: number;

  constructor(maxWaiters = 16) {
    if (!Number.isSafeInteger(maxWaiters) || maxWaiters < 0)
      throw new Error('maxQueuedPerKey must be a non-negative integer');
    this.#maxWaiters = maxWaiters;
  }

  async acquire(key: string, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw signal.reason;
    const waiters = this.#entries.get(key);
    if (!waiters) {
      this.#entries.set(key, []);
      return this.#releaser(key);
    }
    if (waiters.length >= this.#maxWaiters)
      throw new ActionError('RATE_LIMITED', undefined, {
        reason: 'CONCURRENCY_LIMIT',
      });
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve: () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        reject,
      };
      const onAbort = () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      waiters.push(waiter);
    });
    return this.#releaser(key);
  }

  #releaser(key: string): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiters = this.#entries.get(key);
      const next = waiters?.shift();
      if (next) next.resolve();
      else this.#entries.delete(key);
    };
  }

  get activeKeys(): number {
    return this.#entries.size;
  }

  clear(): void {
    for (const waiters of this.#entries.values())
      for (const waiter of waiters.splice(0))
        waiter.reject(
          new ActionError('INTERNAL', undefined, {
            status: 503,
            reason: 'SHUTDOWN',
          }),
        );
    this.#entries.clear();
  }
}
