import { createHash, randomUUID } from 'node:crypto';
import type { RealtimeIdentity } from './hub.js';

export type JobStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
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
export interface JobContext {
  readonly signal: AbortSignal;
  readonly attempt: number;
  progress(percent: number): void;
}
export type JobHandler = (context: JobContext) => Promise<unknown>;
export interface JobRunnerOptions {
  /** Called on every state change, typically `realtime.publish(channel, snapshot)`. */
  readonly notify?: (
    channel: string,
    snapshot: JobSnapshot,
  ) => void | Promise<void>;
  readonly concurrency?: number;
  readonly maxJobs?: number;
  /** Completed job retention in milliseconds. */
  readonly retentionMs?: number;
  readonly now?: () => number;
}
interface Job {
  snapshot: JobSnapshot;
  readonly owner: string;
  readonly handler: JobHandler;
  readonly maxAttempts: number;
  readonly abort: AbortController;
  finishedAt?: number;
}
function owner(identity: RealtimeIdentity): string {
  return createHash('sha256').update(identity.binding).digest('base64url');
}

/**
 * In-process job runner with owner-bound status, progress, cancellation and
 * bounded retries. It is a single-process adapter: jobs do not survive restarts.
 * Use a durable queue (for example BullMQ) behind the same shape for production.
 */
export class JobRunner {
  readonly #jobs = new Map<string, Job>();
  readonly #queue: string[] = [];
  #running = 0;
  readonly #options: Required<Omit<JobRunnerOptions, 'notify'>> &
    Pick<JobRunnerOptions, 'notify'>;
  constructor(options: JobRunnerOptions = {}) {
    this.#options = {
      concurrency: options.concurrency ?? 2,
      maxJobs: options.maxJobs ?? 1000,
      retentionMs: options.retentionMs ?? 600_000,
      now: options.now ?? Date.now,
      ...(options.notify ? { notify: options.notify } : {}),
    };
    if (
      !Number.isSafeInteger(this.#options.concurrency) ||
      this.#options.concurrency < 1
    )
      throw new Error('Invalid job concurrency');
  }
  /** Realtime channel carrying this job's snapshots. */
  static channel(id: string): string {
    return `job:${id}`;
  }
  /** True when the identity owns the job behind a `job:<id>` channel. */
  authorize(identity: RealtimeIdentity, channel: string): boolean {
    const match = /^job:([0-9a-f-]{36})$/.exec(channel);
    const job = match?.[1] ? this.#jobs.get(match[1]) : undefined;
    return job !== undefined && job.owner === owner(identity);
  }
  enqueue(
    identity: RealtimeIdentity,
    name: string,
    handler: JobHandler,
    options: { readonly maxAttempts?: number } = {},
  ): JobSnapshot {
    this.#prune();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name))
      throw new Error('Invalid job name');
    if (this.#jobs.size >= this.#options.maxJobs)
      throw new Error('Job capacity reached');
    const maxAttempts = options.maxAttempts ?? 1;
    if (
      !Number.isSafeInteger(maxAttempts) ||
      maxAttempts < 1 ||
      maxAttempts > 5
    )
      throw new Error('maxAttempts must be 1–5');
    const id = randomUUID();
    const job: Job = {
      owner: owner(identity),
      handler,
      maxAttempts,
      abort: new AbortController(),
      snapshot: Object.freeze({
        id,
        name,
        status: 'queued',
        progress: 0,
        attempts: 0,
        result: null,
        error: null,
      }),
    };
    this.#jobs.set(id, job);
    this.#queue.push(id);
    this.#emit(job);
    this.#pump();
    return job.snapshot;
  }
  /** Owner-only status; other identities receive undefined. */
  get(identity: RealtimeIdentity, id: string): JobSnapshot | undefined {
    const job = this.#jobs.get(id);
    return job && job.owner === owner(identity) ? job.snapshot : undefined;
  }
  cancel(identity: RealtimeIdentity, id: string): boolean {
    const job = this.#jobs.get(id);
    if (!job || job.owner !== owner(identity)) return false;
    if (!['queued', 'running'].includes(job.snapshot.status)) return false;
    job.abort.abort();
    if (job.snapshot.status === 'queued') {
      this.#queue.splice(this.#queue.indexOf(id), 1);
      this.#update(job, { status: 'cancelled' });
    }
    return true;
  }
  #update(job: Job, change: Partial<Omit<JobSnapshot, 'id' | 'name'>>): void {
    job.snapshot = Object.freeze({ ...job.snapshot, ...change });
    if (['succeeded', 'failed', 'cancelled'].includes(job.snapshot.status))
      job.finishedAt = this.#options.now();
    this.#emit(job);
  }
  #emit(job: Job): void {
    const notify = this.#options.notify;
    if (!notify) return;
    void Promise.resolve()
      .then(() => notify(JobRunner.channel(job.snapshot.id), job.snapshot))
      .catch(() => undefined);
  }
  #pump(): void {
    while (this.#running < this.#options.concurrency && this.#queue.length) {
      const id = this.#queue.shift();
      const job = id ? this.#jobs.get(id) : undefined;
      if (!job) continue;
      this.#running++;
      void this.#run(job).finally(() => {
        this.#running--;
        this.#pump();
      });
    }
  }
  async #run(job: Job): Promise<void> {
    for (let attempt = 1; attempt <= job.maxAttempts; attempt++) {
      if (job.abort.signal.aborted) {
        this.#update(job, { status: 'cancelled' });
        return;
      }
      this.#update(job, { status: 'running', attempts: attempt });
      let last = -1;
      try {
        const result = await job.handler({
          signal: job.abort.signal,
          attempt,
          progress: (percent) => {
            const value = Math.max(0, Math.min(100, Math.round(percent)));
            if (!Number.isFinite(value) || value === last) return;
            last = value;
            if (job.snapshot.status === 'running')
              this.#update(job, { progress: value });
          },
        });
        if (job.abort.signal.aborted) {
          this.#update(job, { status: 'cancelled' });
          return;
        }
        let publicResult: unknown;
        try {
          publicResult = JSON.parse(JSON.stringify(result ?? null)) as unknown;
        } catch {
          publicResult = null;
        }
        this.#update(job, {
          status: 'succeeded',
          progress: 100,
          result: publicResult,
        });
        return;
      } catch {
        if (job.abort.signal.aborted) {
          this.#update(job, { status: 'cancelled' });
          return;
        }
        if (attempt === job.maxAttempts) {
          // Never expose raw exception text to the browser.
          this.#update(job, { status: 'failed', error: 'The job failed.' });
          return;
        }
      }
    }
  }
  #prune(): void {
    const now = this.#options.now();
    for (const [id, job] of this.#jobs)
      if (
        job.finishedAt !== undefined &&
        now - job.finishedAt > this.#options.retentionMs
      )
        this.#jobs.delete(id);
  }
  /** Abort running jobs on shutdown. */
  close(): void {
    for (const job of this.#jobs.values()) job.abort.abort();
    this.#queue.length = 0;
  }
}
