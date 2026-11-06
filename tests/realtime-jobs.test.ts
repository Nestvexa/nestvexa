import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { JobRunner, MemoryJobQueue } from '../packages/realtime/dist/index.js';
import type {
  JobContext,
  JobQueue,
  JobRecord,
  JobSnapshot,
} from '../packages/realtime/dist/index.js';

const alice = { binding: 'tenant-a/session/alice' };
const bob = { binding: 'tenant-a/session/bob-xx' };
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function until(check: () => boolean | Promise<boolean>, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached');
}
function runner(options: ConstructorParameters<typeof JobRunner>[0] = {}) {
  const instance = new JobRunner(options);
  cleanup.push(() => instance.close());
  return instance;
}
const status = async (instance: JobRunner, id: string) =>
  (await instance.get(alice, id))?.status;

describe('JobRunner', () => {
  it('reports owner-only progress, retries and redacts failures', async () => {
    const notices: JobSnapshot[] = [];
    const jobs = runner({
      notify: (_channel, snapshot) => void notices.push(snapshot),
    });
    const attempts: number[] = [];
    jobs.register('export', async (context: JobContext) => {
      attempts.push(context.attempt);
      context.progress(50);
      if (context.attempt === 1) throw new Error('database password leaked');
      return { rows: 2, input: context.input };
    });
    jobs.register('boom', async () => {
      throw new Error('secret internals');
    });
    const job = await jobs.enqueue(alice, 'export', {
      input: { month: '2026-11' },
      maxAttempts: 2,
    });
    expect(job.status).toBe('queued');
    await until(async () => (await status(jobs, job.id)) === 'succeeded');
    expect(attempts).toEqual([1, 2]);
    expect(await jobs.get(alice, job.id)).toMatchObject({
      result: { rows: 2, input: { month: '2026-11' } },
      progress: 100,
      attempts: 2,
      error: null,
    });
    expect(await jobs.get(bob, job.id)).toBeUndefined();
    expect(await jobs.authorize(alice, JobRunner.channel(job.id))).toBe(true);
    expect(await jobs.authorize(bob, JobRunner.channel(job.id))).toBe(false);
    expect(await jobs.authorize(alice, 'job:not-a-uuid')).toBe(false);
    await until(() => notices.some((notice) => notice.status === 'succeeded'));
    expect(notices.map((notice) => notice.status)).toEqual(
      expect.arrayContaining(['queued', 'running', 'succeeded']),
    );
    const failing = await jobs.enqueue(alice, 'boom');
    await until(async () => (await status(jobs, failing.id)) === 'failed');
    const failed = await jobs.get(alice, failing.id);
    expect(failed?.error).toBe('The job failed.');
    expect(JSON.stringify(failed)).not.toContain('secret');
    expect(JSON.stringify(notices)).not.toContain('secret');
  });

  it('deduplicates by owner-scoped idempotency key', async () => {
    let runs = 0;
    const jobs = runner();
    jobs.register('charge', async () => {
      runs++;
      return 'ok';
    });
    const first = await jobs.enqueue(alice, 'charge', {
      idempotencyKey: 'order-42',
      input: { amount: 5 },
    });
    const again = await jobs.enqueue(alice, 'charge', {
      idempotencyKey: 'order-42',
      input: { amount: 5 },
    });
    expect(again.id).toBe(first.id);
    // The same key from another identity is a different job.
    const other = await jobs.enqueue(bob, 'charge', {
      idempotencyKey: 'order-42',
      input: { amount: 5 },
    });
    expect(other.id).not.toBe(first.id);
    await until(async () => (await status(jobs, first.id)) === 'succeeded');
    await until(
      async () => (await jobs.get(bob, other.id))?.status === 'succeeded',
    );
    // A retry after completion still returns the original job without rerunning.
    expect(
      (
        await jobs.enqueue(alice, 'charge', {
          idempotencyKey: 'order-42',
          input: { amount: 5 },
        })
      ).status,
    ).toBe('succeeded');
    expect(runs).toBe(2);
    await expect(
      jobs.enqueue(alice, 'charge', {
        idempotencyKey: 'order-42',
        input: { amount: 6 },
      }),
    ).rejects.toThrow(/different job/);
    await expect(
      jobs.enqueue(alice, 'charge', { idempotencyKey: 'bad key!' }),
    ).rejects.toThrow(/idempotency key/);
  });

  it('cancels queued and running jobs for their owner only', async () => {
    const jobs = runner({ concurrency: 1 });
    jobs.register(
      'slow',
      (context) =>
        new Promise((_resolve, reject) =>
          context.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        ),
    );
    const running = await jobs.enqueue(alice, 'slow');
    const queued = await jobs.enqueue(alice, 'slow');
    await until(async () => (await status(jobs, running.id)) === 'running');
    expect(await status(jobs, queued.id)).toBe('queued');
    expect(await jobs.cancel(bob, queued.id)).toBe(false);
    expect(await jobs.cancel(alice, queued.id)).toBe(true);
    expect(await status(jobs, queued.id)).toBe('cancelled');
    expect(await jobs.cancel(alice, running.id)).toBe(true);
    await until(async () => (await status(jobs, running.id)) === 'cancelled');
    expect(await jobs.cancel(alice, running.id)).toBe(false);
  });

  it('expires finished job status after the retention window and bounds capacity', async () => {
    let now = 1_000_000;
    const jobs = runner({ now: () => now, retentionMs: 1000, maxJobs: 2 });
    jobs.register('quick', async () => 1);
    const first = await jobs.enqueue(alice, 'quick');
    await until(async () => (await status(jobs, first.id)) === 'succeeded');
    const second = await jobs.enqueue(alice, 'quick');
    await until(async () => (await status(jobs, second.id)) === 'succeeded');
    await expect(jobs.enqueue(alice, 'quick')).rejects.toThrow(/capacity/);
    now += 1001;
    // Pruning runs on enqueue: expired statuses disappear, capacity frees up.
    const third = await jobs.enqueue(alice, 'quick');
    expect(await jobs.get(alice, first.id)).toBeUndefined();
    expect(await jobs.authorize(alice, JobRunner.channel(first.id))).toBe(
      false,
    );
    await until(async () => (await status(jobs, third.id)) === 'succeeded');
  });

  it('validates registration, names, input and attempts', async () => {
    const jobs = runner();
    jobs.register('ok', async () => null);
    expect(() => jobs.register('ok', async () => null)).toThrow(/already/);
    expect(() => jobs.register('Bad Name', async () => null)).toThrow();
    await expect(jobs.enqueue(alice, 'missing')).rejects.toThrow(
      /No job handler/,
    );
    await expect(
      jobs.enqueue(alice, 'ok', { input: 'x'.repeat(20_000) }),
    ).rejects.toThrow(/16 KiB/);
    await expect(
      jobs.enqueue(alice, 'ok', { maxAttempts: 6 }),
    ).rejects.toThrow();
    expect(() => new JobRunner({ concurrency: 0 })).toThrow();
    expect(() => new JobRunner({ leaseMs: 10 })).toThrow();
  });

  it('hands running jobs back to the queue on shutdown and is closed by Nest', async () => {
    const queue = new MemoryJobQueue();
    const jobs = new JobRunner({ queue });
    let started = false;
    jobs.register('long', (context) => {
      started = true;
      return new Promise((_resolve, reject) =>
        context.signal.addEventListener('abort', () =>
          reject(new Error('shutdown')),
        ),
      );
    });
    @Module({ providers: [{ provide: JobRunner, useValue: jobs }] })
    class JobsModule {}
    const module = await Test.createTestingModule({
      imports: [JobsModule],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    await app.init();
    const job = await jobs.enqueue(alice, 'long');
    await until(() => started);
    await app.close();
    const record = await queue.get(job.id);
    expect(record).toMatchObject({ status: 'queued', leaseOwner: null });
    await expect(jobs.enqueue(alice, 'long')).rejects.toThrow(/closed/);
  });

  it('traces runs with names and attempts only', async () => {
    const spans: { name: string; attributes: object; outcome?: string }[] = [];
    const jobs = runner({
      instrumentation: {
        start(name, attributes) {
          const span: { name: string; attributes: object; outcome?: string } = {
            name,
            attributes,
          };
          spans.push(span);
          return {
            end(outcome) {
              span.outcome = outcome;
            },
          };
        },
      },
    });
    jobs.register('traced', async (context) => ({ secret: context.input }));
    const job = await jobs.enqueue(alice, 'traced', { input: 'private-input' });
    await until(async () => (await status(jobs, job.id)) === 'succeeded');
    await until(() => spans[0]?.outcome === 'ok');
    expect(spans[0]).toMatchObject({
      name: 'nestvexa.job.run',
      attributes: { 'nestvexa.job': 'traced', 'nestvexa.job.attempt': 1 },
    });
    expect(JSON.stringify(spans)).not.toContain('private-input');
  });
});

/** A second process sharing one queue: lease, retry after a crash, cancellation. */
describe('JobQueue contract (MemoryJobQueue) and multiple workers', () => {
  function record(id: string, overrides: Partial<JobRecord> = {}): JobRecord {
    return {
      id,
      name: 'work',
      owner: 'owner-hash',
      input: null,
      idempotencyKey: null,
      maxAttempts: 2,
      status: 'queued',
      progress: 0,
      attempts: 0,
      result: null,
      error: null,
      cancelRequested: false,
      createdAt: 0,
      finishedAt: null,
      leaseOwner: null,
      leaseUntil: null,
      ...overrides,
    };
  }
  it('leases each job to one worker and reclaims lapsed leases', async () => {
    const queue: JobQueue = new MemoryJobQueue();
    await queue.add(record('00000000-0000-4000-8000-000000000001'));
    const first = await queue.claim('worker-a', 1000, 0);
    expect(first).toMatchObject({
      status: 'running',
      attempts: 1,
      leaseOwner: 'worker-a',
    });
    expect(await queue.claim('worker-b', 1000, 10)).toBeUndefined();
    expect(
      await queue.update(first?.id ?? '', 'worker-b', { progress: 5 }),
    ).toBeUndefined();
    // Worker A crashed: after its lease lapses worker B takes over.
    const reclaimed = await queue.claim('worker-b', 1000, 1000);
    expect(reclaimed).toMatchObject({ attempts: 2, leaseOwner: 'worker-b' });
    expect(
      await queue.update(first?.id ?? '', 'worker-a', { status: 'succeeded' }),
    ).toBeUndefined();
    const cancelled = await queue.cancel(first?.id ?? '', 1100);
    expect(cancelled).toMatchObject({
      status: 'running',
      cancelRequested: true,
    });
    expect(
      await queue.add(
        record('00000000-0000-4000-8000-000000000002', {
          idempotencyKey: 'k',
        }),
      ),
    ).toMatchObject({ created: true });
    expect(
      await queue.add(
        record('00000000-0000-4000-8000-000000000003', {
          idempotencyKey: 'k',
        }),
      ),
    ).toMatchObject({
      created: false,
      record: { id: '00000000-0000-4000-8000-000000000002' },
    });
  });

  it('lets a second runner on the same queue finish jobs and observe cancellation', async () => {
    const queue = new MemoryJobQueue();
    const producer = runner({ queue, concurrency: 1 });
    const worker = runner({ queue, pollMs: 20, concurrency: 1, leaseMs: 150 });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The producer registers but is saturated, so the worker picks jobs up.
    producer.register('report', async () => gate);
    worker.register('report', async (context) => {
      context.progress(10);
      await new Promise((resolve) => setTimeout(resolve, 20));
      context.progress(90);
      return { by: 'worker' };
    });
    const blocking = await producer.enqueue(alice, 'report');
    await until(
      async () =>
        (await producer.get(alice, blocking.id))?.status === 'running',
    );
    const job = await producer.enqueue(alice, 'report');
    worker.start();
    await until(
      async () => (await producer.get(alice, job.id))?.status === 'succeeded',
    );
    expect((await producer.get(alice, job.id))?.result).toEqual({
      by: 'worker',
    });
    // Cancelling through the producer reaches the handler on the worker via
    // the queue's cancel flag, observed at the next lease renewal.
    producer.register('stuck', async () => null);
    worker.register(
      'stuck',
      (context) =>
        new Promise((_resolve, reject) =>
          context.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        ),
    );
    const stuck = await producer.enqueue(alice, 'stuck');
    await until(
      async () => (await producer.get(alice, stuck.id))?.status === 'running',
    );
    expect(await producer.cancel(alice, stuck.id)).toBe(true);
    await until(
      async () => (await producer.get(alice, stuck.id))?.status === 'cancelled',
    );
    release();
    await until(
      async () =>
        (await producer.get(alice, blocking.id))?.status === 'succeeded',
    );
  });
});
