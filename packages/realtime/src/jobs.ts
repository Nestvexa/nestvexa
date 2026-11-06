import { createHash, randomUUID } from 'node:crypto';
import type { RealtimeIdentity } from './hub.js';

export type JobStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
/** Public, owner-only view of a job. */
export interface JobSnapshot {
  readonly id: string;
  readonly name: string;
  readonly status: JobStatus;
  /** 0–100. */
  readonly progress: number;
  readonly attempts: number;
  /** Public JSON result on success. */
  readonly result: unknown;
  /** Generic, non-sensitive failure message. */
  readonly error: string | null;
}
/**
 * Stored job. Queues persist these records; handlers are registered by name in
 * every worker process, because functions cannot be persisted.
 */
export interface JobRecord extends JobSnapshot {
  /** SHA-256 of the owner's identity binding (never the binding). */
  readonly owner: string;
  /** Public JSON input passed to the handler (≤16 KiB). */
  readonly input: unknown;
  /** Owner-scoped idempotency key, if the job was enqueued with one. */
  readonly idempotencyKey: string | null;
  readonly maxAttempts: number;
  readonly cancelRequested: boolean;
  readonly createdAt: number;
  readonly finishedAt: number | null;
  /** Worker currently holding the lease, and when the lease lapses. */
  readonly leaseOwner: string | null;
  readonly leaseUntil: number | null;
}
export type JobChange = Partial<
  Pick<
    JobRecord,
    | 'status'
    | 'progress'
    | 'result'
    | 'error'
    | 'finishedAt'
    | 'leaseOwner'
    | 'leaseUntil'
  >
>;
/**
 * Durable job storage and work distribution. Implementations must make `add`
 * atomic per (owner, idempotencyKey), `claim` atomic per job (one lease holder),
 * and `update` conditional on the lease holder. Delivery is at-least-once: a
 * job whose worker died is claimed again after its lease lapses, so handlers
 * must tolerate re-execution.
 */
export interface JobQueue {
  /** Insert `record`, or return the existing job for its owner/idempotency key. */
  add(
    record: JobRecord,
  ): Promise<{ readonly record: JobRecord; readonly created: boolean }>;
  get(id: string): Promise<JobRecord | undefined>;
  /**
   * Lease the oldest queued job (or a running job whose lease lapsed): set
   * `running`, increment `attempts`, record the lease. Undefined when idle.
   */
  claim(
    worker: string,
    leaseMs: number,
    now: number,
  ): Promise<JobRecord | undefined>;
  /** Apply `change` only while `worker` holds the lease; undefined otherwise. */
  update(
    id: string,
    worker: string,
    change: JobChange,
  ): Promise<JobRecord | undefined>;
  /** Request cancellation: queued jobs become cancelled, running jobs are flagged. */
  cancel(id: string, now: number): Promise<JobRecord | undefined>;
  /** Delete finished jobs older than `before`; returns the number removed. */
  prune(before: number): Promise<number>;
  size(): Promise<number>;
  close(): Promise<void>;
}
export interface JobContext {
  readonly id: string;
  readonly signal: AbortSignal;
  readonly attempt: number;
  /** The JSON input given to `enqueue`. */
  readonly input: unknown;
  progress(percent: number): void;
}
export type JobHandler = (context: JobContext) => Promise<unknown>;
export interface JobRunnerOptions {
  /** Storage and distribution (default: a process-local `MemoryJobQueue`). */
  readonly queue?: JobQueue;
  /** Called on every state change, typically `realtime.publish(channel, snapshot)`. */
  readonly notify?: (
    channel: string,
    snapshot: JobSnapshot,
  ) => void | Promise<void>;
  readonly concurrency?: number;
  readonly maxJobs?: number;
  /** Completed job retention in milliseconds. */
  readonly retentionMs?: number;
  /** Lease per claimed job; renewed while the handler runs (default 30 s). */
  readonly leaseMs?: number;
  /** Poll interval after `start()` for jobs enqueued by other processes. */
  readonly pollMs?: number;
  readonly now?: () => number;
  /**
   * Optional tracing hook (see @nestvexa/observability): span
   * `nestvexa.job.run` with job name and attempt only — never input or result.
   */
  readonly instrumentation?: {
    start(
      name: string,
      attributes: Readonly<Record<string, string | number | boolean>>,
    ): {
      end(
        outcome: 'ok' | 'error',
        attributes?: Readonly<Record<string, string | number | boolean>>,
      ): void;
    };
  };
}
export interface EnqueueOptions {
  readonly input?: unknown;
  /** Same owner + key returns the original job instead of a duplicate. */
  readonly idempotencyKey?: string;
  readonly maxAttempts?: number;
}

const finished: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];
const maxJsonBytes = 16_384;
function owner(identity: RealtimeIdentity): string {
  return createHash('sha256').update(identity.binding).digest('base64url');
}
function json(value: unknown, label: string): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    throw new Error(`Job ${label} must be JSON serializable`);
  }
  if (text === undefined || Buffer.byteLength(text) > maxJsonBytes)
    throw new Error(`Job ${label} must be JSON of at most 16 KiB`);
  return JSON.parse(text) as unknown;
}
function snapshot(record: JobRecord): JobSnapshot {
  return Object.freeze({
    id: record.id,
    name: record.name,
    status: record.status,
    progress: record.progress,
    attempts: record.attempts,
    result: record.result,
    error: record.error,
  });
}

/**
 * Process-local `JobQueue` (the default). Bounded by the runner's `maxJobs`;
 * jobs do not survive a restart and are invisible to other processes.
 */
export class MemoryJobQueue implements JobQueue {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #keys = new Map<string, string>();
  #closed = false;
  #key(record: JobRecord): string | undefined {
    return record.idempotencyKey === null
      ? undefined
      : `${record.owner}\n${record.idempotencyKey}`;
  }
  async add(
    record: JobRecord,
  ): Promise<{ readonly record: JobRecord; readonly created: boolean }> {
    if (this.#closed) throw new Error('Job queue is closed');
    const key = this.#key(record);
    const existing = key
      ? this.#jobs.get(this.#keys.get(key) ?? '')
      : undefined;
    if (existing) return { record: existing, created: false };
    const stored = Object.freeze({ ...record });
    this.#jobs.set(stored.id, stored);
    if (key) this.#keys.set(key, stored.id);
    return { record: stored, created: true };
  }
  async get(id: string): Promise<JobRecord | undefined> {
    return this.#jobs.get(id);
  }
  async claim(
    worker: string,
    leaseMs: number,
    now: number,
  ): Promise<JobRecord | undefined> {
    if (this.#closed) return undefined;
    for (const record of this.#jobs.values()) {
      const lapsed =
        record.status === 'running' &&
        record.leaseUntil !== null &&
        record.leaseUntil <= now;
      if (record.status !== 'queued' && !lapsed) continue;
      const claimed: JobRecord = Object.freeze({
        ...record,
        status: 'running',
        attempts: record.attempts + 1,
        leaseOwner: worker,
        leaseUntil: now + leaseMs,
      });
      this.#jobs.set(record.id, claimed);
      return claimed;
    }
    return undefined;
  }
  async update(
    id: string,
    worker: string,
    change: JobChange,
  ): Promise<JobRecord | undefined> {
    const record = this.#jobs.get(id);
    if (!record || record.leaseOwner !== worker) return undefined;
    const next: JobRecord = Object.freeze({ ...record, ...change });
    this.#jobs.set(id, next);
    return next;
  }
  async cancel(id: string, now: number): Promise<JobRecord | undefined> {
    const record = this.#jobs.get(id);
    if (!record || finished.includes(record.status)) return undefined;
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
    this.#jobs.set(id, next);
    return next;
  }
  async prune(before: number): Promise<number> {
    let removed = 0;
    for (const [id, record] of this.#jobs)
      if (record.finishedAt !== null && record.finishedAt < before) {
        this.#jobs.delete(id);
        const key = this.#key(record);
        if (key) this.#keys.delete(key);
        removed++;
      }
    return removed;
  }
  async size(): Promise<number> {
    return this.#jobs.size;
  }
  async close(): Promise<void> {
    this.#closed = true;
  }
}

interface Active {
  readonly abort: AbortController;
  /** Serializes this job's queue writes so progress never overtakes the final status. */
  chain: Promise<unknown>;
  shutdown: boolean;
}

/**
 * Owner-bound jobs with progress, idempotency keys, cancellation, bounded
 * retries and leases over a pluggable `JobQueue`. Register handlers by name in
 * every worker process. With the default `MemoryJobQueue` jobs live in this
 * process only; plug in a durable queue (see the realtime guide's BullMQ
 * recipe) for restarts and multiple workers.
 */
export class JobRunner {
  readonly #queue: JobQueue;
  readonly #handlers = new Map<string, JobHandler>();
  readonly #active = new Map<string, Active>();
  readonly #runs = new Set<Promise<void>>();
  readonly #worker = randomUUID();
  readonly #options: Required<
    Omit<JobRunnerOptions, 'notify' | 'queue' | 'instrumentation'>
  > &
    Pick<JobRunnerOptions, 'notify' | 'instrumentation'>;
  #pumping = false;
  #pumpAgain = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  constructor(options: JobRunnerOptions = {}) {
    this.#queue = options.queue ?? new MemoryJobQueue();
    this.#options = {
      concurrency: options.concurrency ?? 2,
      maxJobs: options.maxJobs ?? 1000,
      retentionMs: options.retentionMs ?? 600_000,
      leaseMs: options.leaseMs ?? 30_000,
      pollMs: options.pollMs ?? 1000,
      now: options.now ?? Date.now,
      ...(options.notify ? { notify: options.notify } : {}),
      ...(options.instrumentation
        ? { instrumentation: options.instrumentation }
        : {}),
    };
    const { concurrency, maxJobs, retentionMs, leaseMs, pollMs } =
      this.#options;
    for (const [name, value, maximum] of [
      ['concurrency', concurrency, 64],
      ['maxJobs', maxJobs, 1_000_000],
      ['retentionMs', retentionMs, 30 * 86_400_000],
      ['leaseMs', leaseMs, 3_600_000],
      ['pollMs', pollMs, 3_600_000],
    ] as const)
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
        throw new Error(`Invalid job ${name}`);
    if (leaseMs < 100) throw new Error('Invalid job leaseMs');
  }
  /** Realtime channel carrying this job's snapshots. */
  static channel(id: string): string {
    return `job:${id}`;
  }
  /** Register the handler for `name` (required in every worker process). */
  register(name: string, handler: JobHandler): this {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name))
      throw new Error('Invalid job name');
    if (typeof handler !== 'function')
      throw new Error('Job handler must be a function');
    if (this.#handlers.has(name))
      throw new Error(`Job handler ${name} is already registered`);
    this.#handlers.set(name, handler);
    return this;
  }
  /** True when the identity owns the job behind a `job:<id>` channel. */
  async authorize(
    identity: RealtimeIdentity,
    channel: string,
  ): Promise<boolean> {
    const match = /^job:([0-9a-f-]{36})$/.exec(channel);
    const record = match?.[1] ? await this.#queue.get(match[1]) : undefined;
    return record !== undefined && record.owner === owner(identity);
  }
  async enqueue(
    identity: RealtimeIdentity,
    name: string,
    options: EnqueueOptions = {},
  ): Promise<JobSnapshot> {
    if (this.#closed) throw new Error('Job runner is closed');
    if (!this.#handlers.has(name))
      throw new Error(`No job handler registered for ${name}`);
    const maxAttempts = options.maxAttempts ?? 1;
    if (
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > 5
    )
      throw new Error('maxAttempts must be 1–5');
    const key = options.idempotencyKey ?? null;
    if (key !== null && !/^[A-Za-z0-9_.:-]{1,128}$/.test(key))
      throw new Error('Invalid job idempotency key');
    const input = json(options.input, 'input');
    const now = this.#options.now();
    await this.#queue.prune(now - this.#options.retentionMs);
    if ((await this.#queue.size()) >= this.#options.maxJobs)
      throw new Error('Job capacity reached');
    const { record, created } = await this.#queue.add(
      Object.freeze({
        id: randomUUID(),
        name,
        owner: owner(identity),
        input,
        idempotencyKey: key,
        maxAttempts,
        status: 'queued',
        progress: 0,
        attempts: 0,
        result: null,
        error: null,
        cancelRequested: false,
        createdAt: now,
        finishedAt: null,
        leaseOwner: null,
        leaseUntil: null,
      }),
    );
    if (!created) {
      // An idempotency key names exactly one request; reuse for another is a bug.
      if (
        record.name !== name ||
        JSON.stringify(record.input) !== JSON.stringify(input)
      )
        throw new Error('Job idempotency key reused for a different job');
      return snapshot(record);
    }
    this.#emit(record);
    this.#pump();
    return snapshot(record);
  }
  /** Owner-only status; other identities receive undefined. */
  async get(
    identity: RealtimeIdentity,
    id: string,
  ): Promise<JobSnapshot | undefined> {
    const record = await this.#queue.get(id);
    return record && record.owner === owner(identity)
      ? snapshot(record)
      : undefined;
  }
  /** Owner-only cancellation of a queued or running job. */
  async cancel(identity: RealtimeIdentity, id: string): Promise<boolean> {
    const record = await this.#queue.get(id);
    if (!record || record.owner !== owner(identity)) return false;
    const cancelled = await this.#queue.cancel(id, this.#options.now());
    if (!cancelled) return false;
    if (cancelled.status === 'cancelled') this.#emit(cancelled);
    this.#active.get(id)?.abort.abort();
    return true;
  }
  /** Poll the queue for jobs enqueued by other processes. */
  start(): void {
    if (this.#closed || this.#timer) return;
    this.#timer = setInterval(() => this.#pump(), this.#options.pollMs);
    this.#timer.unref();
    this.#pump();
  }
  #emit(record: JobRecord): void {
    const notify = this.#options.notify;
    if (!notify) return;
    const value = snapshot(record);
    void Promise.resolve()
      .then(() => notify(JobRunner.channel(value.id), value))
      .catch(() => undefined);
  }
  #pump(): void {
    if (this.#closed) return;
    if (this.#pumping) {
      this.#pumpAgain = true;
      return;
    }
    this.#pumping = true;
    void (async () => {
      try {
        do {
          this.#pumpAgain = false;
          while (
            !this.#closed &&
            this.#active.size < this.#options.concurrency
          ) {
            const record = await this.#queue.claim(
              this.#worker,
              this.#options.leaseMs,
              this.#options.now(),
            );
            if (!record) break;
            this.#start(record);
          }
        } while (this.#pumpAgain && !this.#closed);
      } catch {
        // A queue outage stops this pass; the poll timer or next enqueue retries.
      } finally {
        this.#pumping = false;
      }
    })();
  }
  #start(record: JobRecord): void {
    const active: Active = {
      abort: new AbortController(),
      chain: Promise.resolve(),
      shutdown: false,
    };
    this.#active.set(record.id, active);
    this.#emit(record);
    const run: Promise<void> = this.#run(record, active).finally(() => {
      this.#active.delete(record.id);
      this.#runs.delete(run);
      this.#pump();
    });
    this.#runs.add(run);
  }
  /** Lease-holder write, serialized per job. Undefined once the lease is lost. */
  #write(
    record: JobRecord,
    active: Active,
    change: JobChange,
  ): Promise<JobRecord | undefined> {
    const write = active.chain.then(async () => {
      const next = await this.#queue.update(record.id, this.#worker, change);
      if (!next) active.abort.abort();
      else if (next.cancelRequested) active.abort.abort();
      return next;
    });
    active.chain = write.catch(() => undefined);
    return write;
  }
  async #run(record: JobRecord, active: Active): Promise<void> {
    const handler = this.#handlers.get(record.name);
    const span = this.#options.instrumentation?.start('nestvexa.job.run', {
      'nestvexa.job': record.name,
      'nestvexa.job.attempt': record.attempts,
    });
    const settle = async (change: JobChange, outcome: 'ok' | 'error') => {
      const stored = await this.#write(record, active, change).catch(
        () => undefined,
      );
      span?.end(outcome, { 'nestvexa.job.status': change.status ?? 'running' });
      if (stored) this.#emit(stored);
    };
    if (!handler || record.cancelRequested) {
      await settle(
        record.cancelRequested
          ? { status: 'cancelled', finishedAt: this.#options.now() }
          : {
              status: 'failed',
              error: 'The job failed.',
              finishedAt: this.#options.now(),
            },
        'error',
      );
      return;
    }
    const renew = setInterval(
      () => {
        void this.#write(record, active, {
          leaseUntil: this.#options.now() + this.#options.leaseMs,
        }).catch(() => undefined);
      },
      Math.max(50, Math.floor(this.#options.leaseMs / 3)),
    );
    renew.unref();
    let last = -1;
    try {
      const result = await handler({
        id: record.id,
        signal: active.abort.signal,
        attempt: record.attempts,
        input: record.input,
        progress: (percent) => {
          const value = Math.max(0, Math.min(100, Math.round(percent)));
          if (!Number.isFinite(value) || value === last) return;
          last = value;
          if (active.abort.signal.aborted) return;
          void this.#write(record, active, { progress: value })
            .then((stored) => stored && this.#emit(stored))
            .catch(() => undefined);
        },
      });
      clearInterval(renew);
      if (active.shutdown) {
        await this.#release(record, active);
        span?.end('error', { 'nestvexa.job.status': 'queued' });
        return;
      }
      if (active.abort.signal.aborted) {
        await settle(
          { status: 'cancelled', finishedAt: this.#options.now() },
          'error',
        );
        return;
      }
      let publicResult: unknown;
      try {
        publicResult = json(result, 'result');
      } catch {
        publicResult = null;
      }
      await settle(
        {
          status: 'succeeded',
          progress: 100,
          result: publicResult,
          finishedAt: this.#options.now(),
          leaseOwner: null,
          leaseUntil: null,
        },
        'ok',
      );
    } catch {
      clearInterval(renew);
      if (active.shutdown) {
        await this.#release(record, active);
        span?.end('error', { 'nestvexa.job.status': 'queued' });
        return;
      }
      if (active.abort.signal.aborted) {
        await settle(
          { status: 'cancelled', finishedAt: this.#options.now() },
          'error',
        );
        return;
      }
      // Never expose raw exception text to the browser.
      await settle(
        record.attempts < record.maxAttempts
          ? { status: 'queued', leaseOwner: null, leaseUntil: null }
          : {
              status: 'failed',
              error: 'The job failed.',
              finishedAt: this.#options.now(),
            },
        'error',
      );
    }
  }
  /** Shutdown: hand the job back to the queue for another worker. */
  async #release(record: JobRecord, active: Active): Promise<void> {
    await this.#write(record, active, {
      status: 'queued',
      leaseOwner: null,
      leaseUntil: null,
    }).catch(() => undefined);
  }
  /**
   * Stop claiming, abort running handlers (their jobs return to the queue for
   * another worker) and close the queue. Wired automatically when the runner
   * is a Nest provider.
   */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    for (const active of this.#active.values()) {
      active.shutdown = true;
      active.abort.abort();
    }
    // Handlers should honor the abort signal; one that does not cannot hold
    // shutdown longer than the grace period (its lease then lapses).
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(this.#runs),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
    await this.#queue.close();
  }
  onApplicationShutdown(): Promise<void> {
    return this.close();
  }
}
