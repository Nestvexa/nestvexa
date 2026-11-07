import { createHash } from 'node:crypto';
import type {
  JobChange,
  JobQueue,
  JobRecord,
  JobStatus,
} from '@nestvexa/realtime';
import { expectReply, RespConnection } from './resp.js';
import type { RespConnectionOptions, RespError, RespReply } from './resp.js';

export interface RedisJobQueueOptions extends RespConnectionOptions {
  /** Key prefix isolating one application/environment on a shared server. */
  readonly prefix?: string;
}

const statuses: readonly JobStatus[] = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
];
const finished: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];
const idPattern = /^[0-9a-f-]{36}$/;
const maxRecordBytes = 65_536;
/** Optimistic retries before a contended operation gives up for this pass. */
const maxAttempts = 16;

function invalid(): never {
  throw new Error('Invalid job record');
}
function integer(value: unknown, minimum = 0): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    invalid();
  return value;
}
function nullableInteger(value: unknown): number | null {
  return value === null ? null : integer(value);
}
function token(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid();
  return value;
}
function nullableToken(value: unknown, pattern: RegExp): string | null {
  return value === null ? null : token(value, pattern);
}

/**
 * Validate a stored record. Redis is shared infrastructure, so a value is
 * untrusted until every field has the shape `JobRunner` writes.
 */
function decode(raw: string): JobRecord {
  if (raw.length > maxRecordBytes) invalid();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    invalid();
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const field = (name: string): unknown => Reflect.get(value, name);
  if (field('v') !== 1) invalid();
  const status = field('status');
  if (typeof status !== 'string' || !statuses.includes(status as JobStatus))
    invalid();
  const error = field('error');
  const cancelRequested = field('cancelRequested');
  if (
    (error !== null && (typeof error !== 'string' || error.length > 256)) ||
    typeof cancelRequested !== 'boolean'
  )
    invalid();
  const progress = integer(field('progress'));
  if (progress > 100) invalid();
  return Object.freeze({
    id: token(field('id'), idPattern),
    name: token(field('name'), /^[a-z][a-z0-9-]{0,63}$/),
    owner: token(field('owner'), /^[A-Za-z0-9_-]{1,128}$/),
    input: field('input') ?? null,
    idempotencyKey: nullableToken(
      field('idempotencyKey'),
      /^[A-Za-z0-9_.:-]{1,128}$/,
    ),
    maxAttempts: integer(field('maxAttempts'), 1),
    status: status as JobStatus,
    progress,
    attempts: integer(field('attempts')),
    result: field('result') ?? null,
    error,
    cancelRequested,
    createdAt: integer(field('createdAt')),
    finishedAt: nullableInteger(field('finishedAt')),
    leaseOwner: nullableToken(field('leaseOwner'), /^[A-Za-z0-9_.:-]{1,128}$/),
    leaseUntil: nullableInteger(field('leaseUntil')),
  });
}
function encode(record: JobRecord): string {
  const text = JSON.stringify({ v: 1, ...record });
  // Round-trip through the decoder so nothing unreadable is ever stored.
  decode(text);
  return text;
}
function strings(reply: RespReply): string[] {
  return Array.isArray(reply)
    ? reply.filter((item): item is string => typeof item === 'string')
    : [];
}

interface Plan<T> {
  readonly value: T;
  /** Commands queued between MULTI and EXEC; null commits nothing. */
  readonly commands: readonly (readonly string[])[] | null;
}

/**
 * Durable `JobQueue` for `JobRunner` on a single Redis primary, over RESP with
 * no client library. Jobs survive process restarts and are shared by every
 * worker using the same prefix:
 *
 * - `<prefix>j:<id>` holds the validated JSON record;
 * - sorted sets `queued` (by creation), `running` (by lease expiry) and
 *   `done` (by finish time) index work, crash recovery and retention;
 * - `<prefix>k:<sha256(owner, key)>` maps an idempotency key to its job.
 *
 * Every state change is a `WATCH`/`MULTI`/`EXEC` compare-and-set on the job
 * record, so one worker holds a lease at a time and writes from a worker that
 * lost its lease are refused. Delivery is at-least-once: a job whose worker
 * died is claimed again once its lease lapses. Redis Cluster is not supported
 * (operations span keys in different hash slots).
 */
export class RedisJobQueue implements JobQueue {
  readonly #commands: RespConnection;
  /** Dedicated connection: WATCH/MULTI state is connection-scoped. */
  readonly #transactions: RespConnection;
  readonly #prefix: string;
  #closed = false;
  constructor(options: RedisJobQueueOptions = {}) {
    this.#prefix = options.prefix ?? 'nestvexa:jobs:';
    if (!/^[a-z0-9:._-]{0,64}$/.test(this.#prefix))
      throw new Error('Invalid Redis job queue prefix');
    const connection: RespConnectionOptions = {
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.username === undefined ? {} : { username: options.username }),
      ...(options.password === undefined ? {} : { password: options.password }),
      ...(options.database === undefined ? {} : { database: options.database }),
      ...(options.commandTimeoutMs === undefined
        ? {}
        : { commandTimeoutMs: options.commandTimeoutMs }),
    };
    this.#commands = new RespConnection(connection);
    this.#transactions = new RespConnection(connection);
  }
  #job(id: string): string {
    return `${this.#prefix}j:${id}`;
  }
  #key(owner: string, key: string): string {
    const hash = createHash('sha256').update(`${owner}\n${key}`).digest('hex');
    return `${this.#prefix}k:${hash}`;
  }
  #index(name: 'queued' | 'running' | 'done'): string {
    return `${this.#prefix}${name}`;
  }
  /** Move `record` into the one index matching its status. */
  #indexCommands(record: JobRecord): string[][] {
    const queued = this.#index('queued');
    const running = this.#index('running');
    const done = this.#index('done');
    if (record.status === 'queued')
      return [
        ['ZREM', running, record.id],
        ['ZREM', done, record.id],
        ['ZADD', queued, String(record.createdAt), record.id],
      ];
    if (record.status === 'running')
      return [
        ['ZREM', queued, record.id],
        ['ZREM', done, record.id],
        ['ZADD', running, String(record.leaseUntil ?? 0), record.id],
      ];
    return [
      ['ZREM', queued, record.id],
      ['ZREM', running, record.id],
      ['ZADD', done, String(record.finishedAt ?? record.createdAt), record.id],
    ];
  }
  async #run(...parts: string[]): Promise<Exclude<RespReply, RespError>> {
    if (this.#closed) throw new Error('Job queue is closed');
    return expectReply(await this.#commands.command(...parts));
  }
  /**
   * WATCH `watch`, let `plan` read and decide, then MULTI/EXEC. Resolves
   * `{ value }` when committed (or nothing needed committing) and undefined
   * when a watched key changed before EXEC, so the caller retries.
   */
  async #atomic<T>(
    watch: readonly string[],
    plan: (run: (...parts: string[]) => Promise<RespReply>) => Promise<Plan<T>>,
  ): Promise<{ readonly value: T } | undefined> {
    if (this.#closed) throw new Error('Job queue is closed');
    return this.#transactions.exclusive(async () => {
      const run = async (...parts: string[]) =>
        expectReply(await this.#transactions.command(...parts));
      let watching = false;
      let queued = false;
      try {
        await run('WATCH', ...watch);
        watching = true;
        const { value, commands } = await plan(run);
        if (!commands) return { value };
        await run('MULTI');
        queued = true;
        for (const parts of commands) await run(...parts);
        const result = await run('EXEC');
        queued = false;
        watching = false;
        return Array.isArray(result) ? { value } : undefined;
      } finally {
        // Leave the dedicated connection clean for the next transaction.
        if (queued)
          await this.#transactions.command('DISCARD').catch(() => undefined);
        else if (watching)
          await this.#transactions.command('UNWATCH').catch(() => undefined);
      }
    });
  }
  /** Retry an optimistic operation until it commits without contention. */
  async #retry<T>(
    watch: readonly string[],
    plan: (run: (...parts: string[]) => Promise<RespReply>) => Promise<Plan<T>>,
  ): Promise<T> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const outcome = await this.#atomic(watch, plan);
      if (outcome) return outcome.value;
    }
    throw new Error('Job queue operation did not converge');
  }
  async #read(
    run: (...parts: string[]) => Promise<RespReply>,
    id: string,
  ): Promise<JobRecord | undefined> {
    const raw = await run('GET', this.#job(id));
    if (typeof raw !== 'string') return undefined;
    try {
      return decode(raw);
    } catch {
      return undefined;
    }
  }
  async add(
    record: JobRecord,
  ): Promise<{ readonly record: JobRecord; readonly created: boolean }> {
    const text = encode(record);
    const job = this.#job(record.id);
    const create = [['SET', job, text, 'NX'], ...this.#indexCommands(record)];
    const key =
      record.idempotencyKey === null
        ? undefined
        : this.#key(record.owner, record.idempotencyKey);
    const stored = decode(text);
    type Added = { readonly record: JobRecord; readonly created: boolean };
    return this.#retry<Added>([job, ...(key ? [key] : [])], async (run) => {
      if (key) {
        const existing = await run('GET', key);
        const found =
          typeof existing === 'string' && idPattern.test(existing)
            ? await this.#read(run, existing)
            : undefined;
        if (found)
          return { value: { record: found, created: false }, commands: null };
        // A missing or pruned target is replaced by the new job.
      }
      if ((await run('EXISTS', job)) === 1) throw new Error('Duplicate job id');
      return {
        value: { record: stored, created: true },
        commands: key ? [...create, ['SET', key, record.id]] : create,
      };
    });
  }
  async get(id: string): Promise<JobRecord | undefined> {
    if (!idPattern.test(id)) return undefined;
    const raw = await this.#run('GET', this.#job(id));
    if (typeof raw !== 'string') return undefined;
    try {
      return decode(raw);
    } catch {
      // A tampered record is never shown, authorized or executed.
      return undefined;
    }
  }
  async claim(
    worker: string,
    leaseMs: number,
    now: number,
  ): Promise<JobRecord | undefined> {
    if (this.#closed) return undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Lapsed leases first (their workers died), then the oldest queued job.
      const lapsed = strings(
        await this.#run(
          'ZRANGEBYSCORE',
          this.#index('running'),
          '-inf',
          String(now),
          'LIMIT',
          '0',
          '1',
        ),
      );
      const candidate =
        lapsed[0] ??
        strings(
          await this.#run(
            'ZRANGEBYSCORE',
            this.#index('queued'),
            '-inf',
            '+inf',
            'LIMIT',
            '0',
            '1',
          ),
        )[0];
      if (candidate === undefined) return undefined;
      const job = this.#job(candidate);
      const outcome = await this.#atomic(
        [job],
        async (run): Promise<Plan<JobRecord | 'skip'>> => {
          const raw = await run('GET', job);
          let record: JobRecord | undefined;
          try {
            record = typeof raw === 'string' ? decode(raw) : undefined;
          } catch {
            record = undefined;
          }
          if (!record)
            // Missing or corrupt: drop it from the work indexes, never run it.
            return {
              value: 'skip',
              commands: [
                ['ZREM', this.#index('queued'), candidate],
                ['ZREM', this.#index('running'), candidate],
              ],
            };
          const claimable =
            record.status === 'queued' ||
            (record.status === 'running' &&
              record.leaseUntil !== null &&
              record.leaseUntil <= now);
          if (!claimable) return { value: 'skip', commands: null };
          const claimed: JobRecord = Object.freeze({
            ...record,
            status: 'running',
            attempts: record.attempts + 1,
            leaseOwner: worker,
            leaseUntil: now + leaseMs,
          });
          return {
            value: claimed,
            commands: [
              ['SET', job, encode(claimed)],
              ...this.#indexCommands(claimed),
            ],
          };
        },
      );
      if (outcome && outcome.value !== 'skip') return outcome.value;
    }
    // Heavy contention: the runner's next pump or poll tries again.
    return undefined;
  }
  async update(
    id: string,
    worker: string,
    change: JobChange,
  ): Promise<JobRecord | undefined> {
    if (!idPattern.test(id)) return undefined;
    const job = this.#job(id);
    return this.#retry([job], async (run) => {
      const record = await this.#read(run, id);
      if (!record || record.leaseOwner !== worker)
        return { value: undefined, commands: null };
      const next: JobRecord = Object.freeze({ ...record, ...change });
      return {
        value: next,
        commands: [['SET', job, encode(next)], ...this.#indexCommands(next)],
      };
    });
  }
  async cancel(id: string, now: number): Promise<JobRecord | undefined> {
    if (!idPattern.test(id)) return undefined;
    const job = this.#job(id);
    return this.#retry([job], async (run) => {
      const record = await this.#read(run, id);
      if (!record || finished.includes(record.status))
        return { value: undefined, commands: null };
      const next: JobRecord = Object.freeze(
        record.status === 'queued'
          ? {
              ...record,
              status: 'cancelled',
              cancelRequested: true,
              finishedAt: now,
            }
          : { ...record, cancelRequested: true },
      );
      return {
        value: next,
        commands: [['SET', job, encode(next)], ...this.#indexCommands(next)],
      };
    });
  }
  async prune(before: number): Promise<number> {
    let removed = 0;
    // Bounded per call: the runner prunes on every enqueue.
    for (let round = 0; round < 20; round++) {
      const ids = strings(
        await this.#run(
          'ZRANGEBYSCORE',
          this.#index('done'),
          '-inf',
          `(${before}`,
          'LIMIT',
          '0',
          '100',
        ),
      );
      for (const id of ids) {
        const job = this.#job(id);
        const deleted = await this.#retry([job], async (run) => {
          const record = await this.#read(run, id);
          const forget = [['ZREM', this.#index('done'), id]];
          if (!record) return { value: false, commands: forget };
          if (record.finishedAt === null || record.finishedAt >= before)
            return { value: false, commands: null };
          const commands = [...forget, ['DEL', job]];
          if (record.idempotencyKey !== null) {
            const key = this.#key(record.owner, record.idempotencyKey);
            await run('WATCH', key);
            if ((await run('GET', key)) === id) commands.push(['DEL', key]);
          }
          return { value: true, commands };
        });
        if (deleted) removed++;
      }
      if (ids.length < 100) break;
    }
    return removed;
  }
  async size(): Promise<number> {
    const counts = await Promise.all(
      (['queued', 'running', 'done'] as const).map((name) =>
        this.#run('ZCARD', this.#index(name)),
      ),
    );
    return counts.reduce<number>(
      (total, count) => total + (typeof count === 'number' ? count : 0),
      0,
    );
  }
  /** Close connections; queued and running jobs stay in Redis for other workers. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all([this.#commands.close(), this.#transactions.close()]);
  }
}
