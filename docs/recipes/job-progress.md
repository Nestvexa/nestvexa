# Show background job progress

**Goal:** a button starts a slow report in the background; only the user who
started it sees its progress bar fill and the result arrive, and they can cancel
it.

Example: the report section of
[examples/realtime-dashboard](../../examples/realtime-dashboard/README.md)
(port 3116). Read the [realtime dashboard recipe](realtime-dashboard.md) first.

## 1. Register a job

`JobRunner` from `@nestvexa/realtime` runs registered handlers with a
concurrency limit, an abort signal and `progress()`. Each progress step calls
`notify`, which publishes the job's own channel:

<!-- snippet: examples/realtime-dashboard/src/dashboard.ts -->

```ts
export const reportJobs = new JobRunner({
  concurrency: 2,
  notify: (channel, snapshot) => {
    void publisher?.publish(channel, { status: snapshot.status });
  },
}).register('report', async (context) => {
  for (let step = 1; step <= 4; step++) {
    await delay(200, undefined, { signal: context.signal });
    context.progress(step * 25);
  }
```

## 2. Start, cancel and read it as the owner

Every call passes the owner identity; another identity cannot read or cancel the
job:

<!-- snippet: examples/realtime-dashboard/src/dashboard.ts -->

```ts
  @Action() async startReport(): Promise<void> {
    const identity = { binding: viewerOf(this.request).binding };
    this.jobId = (
      await this.jobs.enqueue(identity, 'report', {
        input: { orders: this.metrics.orders },
      })
    ).id;
  }
```

The component subscribes to `JobRunner.channel(this.jobId)` in
`@RealtimeChannels()`, and `authorizeChannel` delegates unknown channels to
`reportJobs.authorize(identity, channel)`, which admits only the job owner. Before
every render, `dehydrate()` reads the job status with `this.jobs.get(identity, jobId)`
into a `job` state field:

<!-- snippet: examples/realtime-dashboard/views/dashboard.hbs -->

```hbs
      <progress
        id="report-progress"
        max="100"
        value="{{job.progress}}"
        aria-label="Report progress"
      >
```

## Security notes

- Job input and results are plain JSON; failures are redacted before they reach
  the status.
- Pass an `idempotencyKey` to `enqueue` to deduplicate double clicks per owner.
- `MemoryJobQueue` (the default) loses queued jobs on restart. `RedisJobQueue`
  from `@nestvexa/realtime-redis` keeps them across restarts and replicas with
  leases. No BullMQ adapter ships; the guide explains how to keep using BullMQ
  with the same browser side.

## Tests

- [tests/browser/realtime-dashboard.spec.ts](../../tests/browser/realtime-dashboard.spec.ts)
  ("report job progress reaches its owner and completes").
- [tests/realtime-jobs.test.ts](../../tests/realtime-jobs.test.ts): owner-only
  progress, retries, redaction, idempotency keys, cancellation and retention.
- [tests/realtime-job-queue.test.ts](../../tests/realtime-job-queue.test.ts): the
  queue contract, including the Redis queue.

Server actions can also return `202` with a job instead of a result; see
[tests/actions-jobs.test.ts](../../tests/actions-jobs.test.ts) and the
[server actions guide](../guides/server-actions.md#6-long-running-work-job-tickets).

See also: [realtime guide, jobs](../guides/realtime.md#jobs).
