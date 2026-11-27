import { randomBytes } from 'node:crypto';
import type {
  ActionIdempotencyStore,
  IdempotencyBeginResult,
  StoredActionOutcome,
} from '@nestvexa/actions';
import { atomic, connectionOptions } from './atomic.js';
import { expectReply, RespConnection } from './resp.js';
import type { RespConnectionOptions, RespReply } from './resp.js';

export interface RedisActionIdempotencyStoreOptions extends RespConnectionOptions {
  /** Key prefix isolating one application/environment on a shared server. */
  readonly prefix?: string;
  /**
   * Lease on an in-progress claim (default 30 s, 1 s to 10 min). The owning
   * process renews it every third of the lease while the handler runs, so a
   * long action keeps its claim and a crashed process releases it after at
   * most one lease. Shorter leases free a crashed claim sooner; a lease must
   * outlive any Redis outage the owner should survive without losing it.
   */
  readonly leaseMs?: number;
  /** Largest stored outcome in UTF-8 JSON bytes (default 4 MiB, at most 6 MiB). */
  readonly maxOutcomeBytes?: number;
  /** Test injection only: claim owners need 128 bits of randomness. */
  readonly randomOwner?: () => string;
}

const hexKey = /^[0-9a-f]{64}$/;
const ownerPattern = /^[A-Za-z0-9_-]{16,64}$/;

interface Claim {
  readonly owner: string;
  readonly ttlMs: number;
  readonly leaseMs: number;
  timer: ReturnType<typeof setInterval> | undefined;
  /** Completion failed: the effect may have happened, so the claim is never released early. */
  poisoned: boolean;
}
interface Pending {
  readonly fingerprint: string;
  readonly owner: string;
}
interface Done {
  readonly fingerprint: string;
  readonly outcome: StoredActionOutcome;
}

function invalid(message: string): never {
  throw new Error(`Redis idempotency store: ${message}`);
}
/**
 * Redis failures are never treated as "no record": the call fails (the
 * runtime answers 500 and the handler does not run). The message carries no
 * keys or values; the original error is kept as `cause` for logs.
 */
function unavailable(cause: unknown): never {
  const error = new Error('Action idempotency store is unavailable');
  Object.defineProperty(error, 'cause', { value: cause });
  throw error;
}
function bounded(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    invalid(`invalid ${name}`);
  return value;
}
/** Parse a stored record; a corrupt record fails closed instead of reading as absent. */
function parse(raw: string): Pending | Done {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid('corrupt record');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid('corrupt record');
  const fingerprint: unknown = Reflect.get(value, 'f');
  const owner: unknown = Reflect.get(value, 'o');
  const outcome: unknown = Reflect.get(value, 'r');
  if (Reflect.get(value, 'v') !== 1 || typeof fingerprint !== 'string')
    invalid('corrupt record');
  if (typeof owner === 'string' && outcome === undefined)
    return { fingerprint, owner };
  if (
    owner === undefined &&
    outcome !== null &&
    typeof outcome === 'object' &&
    !Array.isArray(outcome) &&
    Object.hasOwn(outcome, 'data')
  )
    return { fingerprint, outcome: outcome as StoredActionOutcome };
  invalid('corrupt record');
}
function pendingFor(raw: RespReply, owner: string): boolean {
  if (typeof raw !== 'string') return false;
  const record = parse(raw);
  return 'owner' in record && record.owner === owner;
}

/**
 * Shared server-action idempotency for restarts and multiple replicas, over
 * RESP with no client library (`ActionIdempotencyStore` from
 * `@nestvexa/actions`):
 *
 * - `begin` claims a key with `SET NX PX` (atomic across replicas); a claim
 *   is a lease owned by a random token and renewed while the handler runs;
 * - `complete` replaces the claim with the outcome, retained for the
 *   runtime's TTL, only while this process still owns it
 *   (`WATCH`/`MULTI`/`EXEC` compare-and-set); `abandon` deletes it the same
 *   way, so a lapsed claim taken over by another replica is never touched;
 * - keys arrive scoped by tenant, subject, group, action and version and
 *   hashed by the runtime; records hold the input fingerprint and the
 *   outcome, never identities;
 * - fail closed: a Redis error or a corrupt record fails the call before
 *   the handler runs. When storing the outcome fails, the claim is kept
 *   (not released) so retries get `409 IDEMPOTENCY_IN_PROGRESS` until its
 *   lease lapses, instead of running the effect again at once.
 *
 * Targets a single Redis primary (standalone or Sentinel-managed). Records
 * live only as long as Redis keeps them: use persistence (AOF) if a Redis
 * restart must not forget completed keys.
 */
export class RedisActionIdempotencyStore implements ActionIdempotencyStore {
  readonly #commands: RespConnection;
  /** Dedicated connection: WATCH/MULTI state is connection-scoped. */
  readonly #transactions: RespConnection;
  readonly #prefix: string;
  readonly #leaseMs: number;
  readonly #maxOutcomeBytes: number;
  readonly #owner: () => string;
  /** Claims this process started and has not settled. */
  readonly #claims = new Map<string, Claim>();
  #closed = false;

  constructor(options: RedisActionIdempotencyStoreOptions = {}) {
    this.#prefix = options.prefix ?? 'nestvexa:actions:idem:';
    if (!/^[a-z0-9:._-]{0,64}$/.test(this.#prefix)) invalid('invalid prefix');
    this.#leaseMs = bounded(options.leaseMs ?? 30_000, 1000, 600_000, 'lease');
    this.#maxOutcomeBytes = bounded(
      options.maxOutcomeBytes ?? 4_194_304,
      1024,
      6_291_456,
      'outcome limit',
    );
    this.#owner =
      options.randomOwner ?? (() => randomBytes(16).toString('base64url'));
    const connection = connectionOptions(options);
    this.#commands = new RespConnection(connection);
    this.#transactions = new RespConnection(connection);
  }

  /** Claims this process currently holds (in progress here). */
  get activeClaims(): number {
    return this.#claims.size;
  }

  #key(key: string): string {
    if (typeof key !== 'string' || !hexKey.test(key))
      invalid('keys must be SHA-256 hex digests');
    return `${this.#prefix}${key}`;
  }
  async #command(...parts: string[]): Promise<RespReply> {
    try {
      return expectReply(await this.#commands.command(...parts));
    } catch (error) {
      unavailable(error);
    }
  }
  async #atomic(
    watch: readonly string[],
    plan: (
      run: (...parts: string[]) => Promise<RespReply>,
    ) => Promise<readonly (readonly string[])[] | null>,
  ): Promise<RespReply[] | null> {
    try {
      return await atomic(this.#transactions, watch, plan);
    } catch (error) {
      unavailable(error);
    }
  }

  async begin(
    key: string,
    fingerprint: string,
    ttlMs: number,
  ): Promise<IdempotencyBeginResult> {
    if (this.#closed) invalid('store is closed');
    const name = this.#key(key);
    if (typeof fingerprint !== 'string' || !hexKey.test(fingerprint))
      invalid('fingerprints must be SHA-256 hex digests');
    bounded(ttlMs, 1000, 604_800_000, 'TTL');
    const owner = this.#owner();
    if (!ownerPattern.test(owner)) invalid('invalid claim owner');
    const leaseMs = Math.min(this.#leaseMs, ttlMs);
    const claim = JSON.stringify({ v: 1, f: fingerprint, o: owner });
    // A record can expire between SET NX and GET; claim again (bounded).
    for (let attempt = 0; attempt < 3; attempt++) {
      const reply = await this.#command(
        'SET',
        name,
        claim,
        'NX',
        'PX',
        String(leaseMs),
      );
      if (reply === 'OK') {
        this.#hold(key, {
          owner,
          ttlMs,
          leaseMs,
          timer: undefined,
          poisoned: false,
        });
        return { status: 'started' };
      }
      const raw = await this.#command('GET', name);
      if (typeof raw !== 'string') continue;
      const record = parse(raw);
      if (record.fingerprint !== fingerprint) return { status: 'mismatch' };
      return 'outcome' in record
        ? { status: 'replay', outcome: record.outcome }
        : { status: 'in-progress' };
    }
    unavailable(new Error('Idempotency claim kept expiring'));
  }

  /** Track a claim and renew its lease while the handler runs. */
  #hold(key: string, claim: Claim): void {
    this.#claims.set(key, claim);
    const name = this.#key(key);
    claim.timer = setInterval(
      () => {
        void this.#atomic([name], async (run) =>
          pendingFor(await run('GET', name), claim.owner)
            ? [['PEXPIRE', name, String(claim.leaseMs)]]
            : null,
        ).catch(() => {
          // The next renewal retries; a lease that lapses is never committed.
        });
      },
      Math.max(250, Math.floor(claim.leaseMs / 3)),
    );
    claim.timer.unref();
  }
  #release(claim: Claim): void {
    if (claim.timer !== undefined) clearInterval(claim.timer);
    claim.timer = undefined;
  }

  async complete(key: string, outcome: StoredActionOutcome): Promise<void> {
    const claim = this.#claims.get(key);
    // Not claimed by this process (or already settled): nothing to record.
    if (!claim || claim.poisoned) return;
    this.#release(claim);
    const name = this.#key(key);
    try {
      const outcomeText = JSON.stringify(outcome);
      if (
        typeof outcomeText !== 'string' ||
        Buffer.byteLength(outcomeText) > this.#maxOutcomeBytes
      )
        throw new Error('Action outcome exceeds the idempotency store limit');
      const committed = await this.#atomic([name], async (run) => {
        const raw = await run('GET', name);
        if (typeof raw !== 'string' || !pendingFor(raw, claim.owner))
          return null;
        const record = `{"v":1,"f":${JSON.stringify(parse(raw).fingerprint)},"r":${outcomeText}}`;
        return [['SET', name, record, 'PX', String(claim.ttlMs)]];
      });
      if (!committed)
        throw new Error('Idempotency claim lapsed before the action completed');
      this.#claims.delete(key);
    } catch (error) {
      // Fail closed: the handler ran, so the claim stays until its lease
      // lapses and the runtime's follow-up `abandon` is ignored.
      claim.poisoned = true;
      throw error;
    }
  }

  async abandon(key: string): Promise<void> {
    const claim = this.#claims.get(key);
    if (!claim) return;
    this.#claims.delete(key);
    this.#release(claim);
    if (claim.poisoned) return;
    const name = this.#key(key);
    await this.#atomic([name], async (run) =>
      pendingFor(await run('GET', name), claim.owner) ? [['DEL', name]] : null,
    );
  }

  /**
   * Stop renewing claims and close connections. Records stay in Redis for
   * the other replicas; claims still in progress here lapse after their lease.
   */
  async close(): Promise<void> {
    this.#closed = true;
    for (const claim of this.#claims.values()) this.#release(claim);
    this.#claims.clear();
    await Promise.all([this.#commands.close(), this.#transactions.close()]);
  }
}
