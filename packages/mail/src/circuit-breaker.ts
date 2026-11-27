// Package-local copy of the Nestvexa circuit breaker. The same file ships in
// @nestvexa/realtime, @nestvexa/realtime-redis, @nestvexa/uploads,
// @nestvexa/ai and @nestvexa/mail so optional packages stay dependency-free;
// tests/circuit-breaker.test.ts keeps the copies identical. See
// docs/guides/resilience.md.

/** Tuning for one breaker. */
export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. Default 5 (1-1000). */
  readonly failureThreshold?: number;
  /** How long an open circuit fails fast before one probe. Default 10000 ms (100-600000). */
  readonly cooldownMs?: number;
  /** Clock in milliseconds; for tests. Default `Date.now`. */
  readonly now?: () => number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

/** One admitted call; settle it exactly once (later calls are ignored). */
export interface CircuitCall {
  /** The dependency answered: closes the circuit and resets the count. */
  succeed(): void;
  /** The dependency was unreachable, timed out or failed on its side. */
  fail(): void;
  /** No verdict (for example the caller cancelled); frees a probe slot. */
  release(): void;
}

/**
 * Thrown without calling the dependency while the circuit is open, or while
 * the single half-open probe is still running. `retryAfterMs` is the time
 * until the next probe may run (0 while a probe is in flight).
 */
export class CircuitOpenError extends Error {
  constructor(
    readonly service: string,
    readonly retryAfterMs: number,
  ) {
    super(`${service} is unavailable (circuit open); failing fast`);
    this.name = 'CircuitOpenError';
  }
}

function bounded(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw new Error(`Invalid circuit breaker ${label}`);
  return result;
}

/**
 * Consecutive-failure circuit breaker for one optional remote dependency.
 * Closed: calls run and failures are counted; a success resets the count.
 * After `failureThreshold` consecutive failures the circuit opens and every
 * call fails fast with `CircuitOpenError` for `cooldownMs`. Then exactly one
 * probe call runs (half-open): success closes the circuit, failure reopens it
 * for another cooldown. Only failures the caller classifies as dependency
 * failures count; ordinary refusals (a missing object, a rejected command)
 * do not open the circuit.
 */
export class CircuitBreaker {
  readonly #threshold: number;
  readonly #cooldown: number;
  readonly #now: () => number;
  #failures = 0;
  #openedAt: number | undefined;
  #probing = false;

  constructor(
    readonly service: string,
    options: CircuitBreakerOptions = {},
  ) {
    this.#threshold = bounded(
      options.failureThreshold,
      5,
      1,
      1000,
      'failureThreshold',
    );
    this.#cooldown = bounded(
      options.cooldownMs,
      10_000,
      100,
      600_000,
      'cooldownMs',
    );
    this.#now = options.now ?? Date.now;
  }

  get state(): CircuitState {
    if (this.#openedAt === undefined) return 'closed';
    return this.#now() - this.#openedAt >= this.#cooldown
      ? 'half-open'
      : 'open';
  }

  /** Consecutive dependency failures counted since the last success. */
  get failures(): number {
    return this.#failures;
  }

  /**
   * Run `operation` through the breaker. `isFailure` decides whether a thrown
   * error counts against the dependency (default: every error does); any
   * other error, like a result, proves the dependency answered. The original
   * error is always rethrown unchanged.
   */
  async run<T>(
    operation: () => Promise<T>,
    isFailure: (error: unknown) => boolean = () => true,
  ): Promise<T> {
    const call = this.attempt();
    try {
      const result = await operation();
      call.succeed();
      return result;
    } catch (error) {
      if (isFailure(error)) call.fail();
      else call.succeed();
      throw error;
    }
  }

  /**
   * Admit one call for callers that cannot wrap a single promise (streams,
   * generators). Throws `CircuitOpenError` when the call must fail fast.
   * Settle the returned call once: `succeed`, `fail`, or `release` when the
   * outcome says nothing about the dependency (for example a cancellation).
   */
  attempt(): CircuitCall {
    let probe = false;
    if (this.#openedAt !== undefined) {
      const elapsed = this.#now() - this.#openedAt;
      if (elapsed < this.#cooldown)
        throw new CircuitOpenError(this.service, this.#cooldown - elapsed);
      if (this.#probing) throw new CircuitOpenError(this.service, 0);
      this.#probing = probe = true;
    }
    let settled = false;
    const settle = (outcome: 'success' | 'failure' | 'none'): void => {
      if (settled) return;
      settled = true;
      if (probe) this.#probing = false;
      if (outcome === 'success') {
        this.#failures = 0;
        this.#openedAt = undefined;
      } else if (outcome === 'failure') {
        this.#failures++;
        if (this.#openedAt !== undefined || this.#failures >= this.#threshold)
          this.#openedAt = this.#now();
      }
    };
    return Object.freeze({
      succeed: () => settle('success'),
      fail: () => settle('failure'),
      release: () => settle('none'),
    });
  }
}
