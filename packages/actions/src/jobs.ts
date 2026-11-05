import { JOB_NAME_PATTERN } from './shared/protocol.js';

/**
 * Owner key handed to the job queue. It is derived by the runtime from the
 * host-resolved identity (tenant + subject), never from the request body, and
 * is structurally compatible with `@nestvexa/realtime`'s `RealtimeIdentity`.
 */
export interface ActionJobOwner {
  readonly binding: string;
}
export interface ActionJobContext {
  /** Aborted when the job is cancelled. Independent of the HTTP request. */
  readonly signal: AbortSignal;
  readonly attempt: number;
  /** Report progress 0-100; non-finite values are ignored by queues. */
  progress(percent: number): void;
}
export type ActionJobHandler<T> = (context: ActionJobContext) => Promise<T>;
/** Minimal job record a queue returns; extra fields (name, attempts) are ignored. */
export interface ActionJobRecord {
  readonly id: string;
  readonly status: string;
  readonly progress: number;
  readonly result: unknown;
  readonly error: string | null;
}
/**
 * Queue contract for long-running actions. `@nestvexa/realtime`'s
 * `JobRunner` satisfies it structurally; a durable queue (BullMQ, a database
 * outbox) can implement the same three methods. Every method must enforce
 * owner binding: `get`/`cancel` for another owner return undefined/false.
 */
export interface ActionJobQueue {
  enqueue(
    owner: ActionJobOwner,
    name: string,
    handler: (context: ActionJobContext) => Promise<unknown>,
    options?: { readonly maxAttempts?: number },
  ): ActionJobRecord | Promise<ActionJobRecord>;
  get(
    owner: ActionJobOwner,
    id: string,
  ): ActionJobRecord | undefined | Promise<ActionJobRecord | undefined>;
  cancel?(owner: ActionJobOwner, id: string): boolean | Promise<boolean>;
}
export interface ActionJobsOptions {
  readonly queue: ActionJobQueue;
  /**
   * Optional streaming handle: maps a job id to a realtime channel that
   * carries its snapshots (for example `JobRunner.channel`). The realtime
   * policy must authorize that channel per owner (`JobRunner.authorize`).
   */
  readonly channel?: (id: string) => string;
  /** Suggested client poll delay in milliseconds, default 1000 (100-60000). */
  readonly pollAfterMs?: number;
  /**
   * Maps the verified identity to the queue owner. Default: an opaque hash of
   * tenant + subject. Supply one when the realtime host must authorize the
   * job channel with its own identity binding (for example `user:<id>`).
   */
  readonly owner?: (identity: {
    readonly subject: string;
    readonly tenant?: string;
  }) => ActionJobOwner;
}

/**
 * Returned by a `job: true` server action: the runtime enqueues the handler
 * with the caller as owner and answers 202 with a job ticket. The type
 * parameter is the job's JSON result, preserved by the code generator.
 */
export class AcceptedJob<T> {
  readonly name: string;
  readonly handler: ActionJobHandler<T>;
  readonly maxAttempts: number | undefined;
  private constructor(
    name: string,
    handler: ActionJobHandler<T>,
    maxAttempts: number | undefined,
  ) {
    this.name = name;
    this.handler = handler;
    this.maxAttempts = maxAttempts;
    Object.freeze(this);
  }
  static of<T>(
    name: string,
    handler: ActionJobHandler<T>,
    options: { readonly maxAttempts?: number } = {},
  ): AcceptedJob<T> {
    if (typeof name !== 'string' || !JOB_NAME_PATTERN.test(name))
      throw new TypeError(
        'Job names must be lowercase kebab-case (at most 64 characters)',
      );
    if (typeof handler !== 'function')
      throw new TypeError('acceptJob requires a handler function');
    const maxAttempts = options.maxAttempts;
    if (
      maxAttempts !== undefined &&
      (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5)
    )
      throw new TypeError('Job maxAttempts must be an integer 1-5');
    return new AcceptedJob(name, handler, maxAttempts);
  }
}

/** `return acceptJob('export-report', async ({ progress, signal }) => ...)` */
export function acceptJob<T>(
  name: string,
  handler: ActionJobHandler<T>,
  options?: { readonly maxAttempts?: number },
): AcceptedJob<T> {
  return AcceptedJob.of(name, handler, options);
}
