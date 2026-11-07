import { afterEach, describe, expect, it } from 'vitest';
import { JobRunner, MemoryJobQueue } from '../packages/realtime/dist/index.js';
import type {
  JobQueue,
  JobRecord,
  JobSnapshot,
} from '../packages/realtime/dist/index.js';
import { RedisJobQueue } from '../packages/realtime-redis/dist/realtime.js';
import { respDouble } from './support/resp-double.js';
import type { RespDouble } from './support/resp-double.js';

/*
 * One JobQueue contract, run against the process-local MemoryJobQueue and the
 * durable RedisJobQueue (over the in-process RESP double; real Redis is
 * exercised by `pnpm test:services`). Separate RedisJobQueue instances stand
 * in for separate worker processes: they share nothing but the server.
 */
const alice = { binding: 'tenant-a/session/alice' };
const bob = { binding: 'tenant-a/session/bob-xx' };
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
async function until(check: () => boolean | Promise<boolean>, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not reached');
}
let counter = 0;
function id(): string {
  counter++;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}
function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: id(),
    name: 'work',
    owner: 'owner-hash',
    input: { month: '2026-11' },
    idempotencyKey: null,
    maxAttempts: 2,
    status: 'queued',
    progress: 0,
    attempts: 0,
    result: null,
    error: null,
    cancelRequested: false,
    createdAt: counter,
    finishedAt: null,
    leaseOwner: null,
    leaseUntil: null,
    ...overrides,
  };
}

interface Backend {
  /** A queue instance; with Redis each call is a separate "process". */
  queue(): JobQueue;
  server?: RespDouble;
}
const backends: Record<string, () => Promise<Backend>> = {
  memory: async () => {
    const shared = new MemoryJobQueue();
    return { queue: () => shared };
  },
  redis: async () => {
    const server = await respDouble();
    cleanup.push(() => server.close());
    const prefix = `jobs${counter}:`;
    return {
      server,
      queue: () => {
        const queue = new RedisJobQueue({ port: server.port, prefix });
        cleanup.push(() => queue.close());
        return queue;
      },
    };
  },
};

describe.each(Object.keys(backends))('JobQueue contract (%s)', (name) => {
  const backend = () => {
    const create = backends[name];
    if (!create) throw new Error('unknown backend');
    return create();
  };

  it('adds, reads and deduplicates by owner and idempotency key', async () => {
    const b = await backend();
    const queue = b.queue();
    const first = record({ idempotencyKey: 'report:1' });
    expect(await queue.add(first)).toMatchObject({
      created: true,
      record: { id: first.id, input: { month: '2026-11' } },
    });
    expect(await queue.get(first.id)).toMatchObject({ status: 'queued' });
    // Same owner + key from another process returns the original job.
    const again = await b.queue().add(record({ idempotencyKey: 'report:1' }));
    expect(again).toMatchObject({ created: false, record: { id: first.id } });
    // Another owner's identical key is a different job.
    expect(
      await queue.add(
        record({ owner: 'other-owner', idempotencyKey: 'report:1' }),
      ),
    ).toMatchObject({ created: true });
    expect(await queue.get('00000000-0000-4000-8000-999999999999')).toBe(
      undefined,
    );
    expect(await queue.size()).toBe(2);
  });

  it('leases each job to one worker, refuses writes without the lease and reclaims lapsed leases', async () => {
    const b = await backend();
    const workerA = b.queue();
    const workerB = b.queue();
    const job = record();
    await workerA.add(job);
    const claimed = await workerA.claim('worker-a', 1000, 0);
    expect(claimed).toMatchObject({
      id: job.id,
      status: 'running',
      attempts: 1,
      leaseOwner: 'worker-a',
      leaseUntil: 1000,
    });
    expect(await workerB.claim('worker-b', 1000, 10)).toBeUndefined();
    expect(
      await workerB.update(job.id, 'worker-b', { progress: 5 }),
    ).toBeUndefined();
    expect(
      await workerA.update(job.id, 'worker-a', { progress: 40 }),
    ).toMatchObject({ progress: 40 });
    // Worker A crashed: once its lease lapses worker B takes over.
    const reclaimed = await workerB.claim('worker-b', 1000, 1000);
    expect(reclaimed).toMatchObject({
      attempts: 2,
      leaseOwner: 'worker-b',
      progress: 40,
    });
    // The crashed worker's late write is refused.
    expect(
      await workerA.update(job.id, 'worker-a', { status: 'succeeded' }),
    ).toBeUndefined();
    expect(
      await workerB.update(job.id, 'worker-b', {
        status: 'succeeded',
        progress: 100,
        result: { rows: 3 },
        finishedAt: 1500,
      }),
    ).toMatchObject({ status: 'succeeded', result: { rows: 3 } });
    expect(await workerA.claim('worker-a', 1000, 5000)).toBeUndefined();
  });

  it('claims the oldest queued job first and returns released jobs to the queue', async () => {
    const b = await backend();
    const queue = b.queue();
    const older = record({ createdAt: 1 });
    const newer = record({ createdAt: 2 });
    await queue.add(newer);
    await queue.add(older);
    const first = await queue.claim('w', 1000, 10);
    expect(first?.id).toBe(older.id);
    // A shutdown hands the job back; it is claimable again.
    await queue.update(older.id, 'w', {
      status: 'queued',
      leaseOwner: null,
      leaseUntil: null,
    });
    expect((await queue.claim('w2', 1000, 20))?.id).toBe(older.id);
    expect((await queue.claim('w2', 1000, 20))?.id).toBe(newer.id);
    expect(await queue.claim('w2', 1000, 20)).toBeUndefined();
  });

  it('cancels queued jobs immediately and flags running jobs', async () => {
    const b = await backend();
    const queue = b.queue();
    const running = record({ createdAt: 1 });
    const waiting = record({ createdAt: 2 });
    await queue.add(running);
    await queue.add(waiting);
    await queue.claim('w', 1000, 0);
    expect(await queue.cancel(waiting.id, 50)).toMatchObject({
      status: 'cancelled',
      cancelRequested: true,
      finishedAt: 50,
    });
    expect(await queue.cancel(running.id, 60)).toMatchObject({
      status: 'running',
      cancelRequested: true,
    });
    // The flag is visible to the lease holder on its next write.
    expect(
      await b.queue().update(running.id, 'w', { progress: 10 }),
    ).toMatchObject({ cancelRequested: true });
    expect(await queue.cancel(waiting.id, 70)).toBeUndefined();
    expect(await queue.claim('w', 1000, 100)).toBeUndefined();
  });

  it('prunes finished jobs older than the cutoff with their idempotency keys', async () => {
    const b = await backend();
    const queue = b.queue();
    const old = record({ idempotencyKey: 'old' });
    const recent = record();
    const open = record();
    for (const item of [old, recent, open]) await queue.add(item);
    await queue.cancel(old.id, 100);
    await queue.cancel(recent.id, 500);
    expect(await queue.prune(200)).toBe(1);
    expect(await queue.get(old.id)).toBeUndefined();
    expect(await queue.get(recent.id)).toMatchObject({ status: 'cancelled' });
    expect(await queue.get(open.id)).toMatchObject({ status: 'queued' });
    expect(await queue.size()).toBe(2);
    // The key is free again once its job is gone.
    expect(await queue.add(record({ idempotencyKey: 'old' }))).toMatchObject({
      created: true,
    });
  });
});

describe('RedisJobQueue durability and hardening', () => {
  async function server() {
    const double = await respDouble();
    cleanup.push(() => double.close());
    return double;
  }
  function queue(port: number, prefix = 'durable:') {
    const instance = new RedisJobQueue({ port, prefix });
    cleanup.push(() => instance.close());
    return instance;
  }

  it('lets one claimant win when workers race for the same job', async () => {
    const double = await server();
    const workers = Array.from({ length: 6 }, () => queue(double.port));
    const jobs = Array.from({ length: 3 }, () => record());
    for (const job of jobs) await workers[0]?.add(job);
    const claims = await Promise.all(
      workers.map((worker, index) => worker.claim(`w${index}`, 1000, 0)),
    );
    const ids = claims.flatMap((claim) => (claim ? [claim.id] : []));
    // Every job is leased exactly once; extra workers get nothing.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(jobs.map((job) => job.id).sort());
  });

  it('survives a worker process restart: a new runner finishes the queued job', async () => {
    const double = await server();
    const notices: JobSnapshot[] = [];
    const first = new JobRunner({ queue: queue(double.port), concurrency: 1 });
    first.register(
      'report',
      ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('stop'))),
        ),
    );
    const blocker = await first.enqueue(alice, 'report');
    await until(
      async () => (await first.get(alice, blocker.id))?.status === 'running',
    );
    const job = await first.enqueue(alice, 'report', {
      input: { month: '2026-10' },
      idempotencyKey: 'monthly:2026-10',
    });
    // The first process shuts down: its running job goes back to the queue
    // and the second job never started there.
    await first.close();
    const second = new JobRunner({
      queue: queue(double.port),
      pollMs: 20,
      notify: (_channel, snapshot) => void notices.push(snapshot),
    });
    cleanup.push(() => second.close());
    second.register('report', async ({ input, progress }) => {
      progress(50);
      return { input };
    });
    second.start();
    await until(
      async () => (await second.get(alice, job.id))?.status === 'succeeded',
    );
    expect(await second.get(alice, job.id)).toMatchObject({
      result: { input: { month: '2026-10' } },
      progress: 100,
      attempts: 1,
    });
    // Ownership survives the restart: another identity sees nothing.
    expect(await second.get(bob, job.id)).toBeUndefined();
    expect(await second.authorize(bob, JobRunner.channel(job.id))).toBe(false);
    expect(await second.authorize(alice, JobRunner.channel(job.id))).toBe(true);
    // Retrying the same request in the new process returns the same job.
    const again = await second.enqueue(alice, 'report', {
      input: { month: '2026-10' },
      idempotencyKey: 'monthly:2026-10',
    });
    expect(again.id).toBe(job.id);
    expect(notices.some((notice) => notice.progress === 50)).toBe(true);
    // The handed-back job runs again (second attempt) in the new process.
    await until(
      async () => (await second.get(alice, blocker.id))?.status === 'succeeded',
    );
    expect((await second.get(alice, blocker.id))?.attempts).toBe(2);
  });

  it('recovers a job whose worker crashed mid-run once the lease lapses', async () => {
    const double = await server();
    // A crashed worker: it claimed with a short lease and never wrote again.
    const crashed = queue(double.port);
    const shared = queue(double.port);
    await shared.add(
      record({ name: 'import', owner: 'owner-hash', maxAttempts: 1 }),
    );
    const leased = await crashed.claim('dead-worker', 150, Date.now());
    expect(leased?.leaseOwner).toBe('dead-worker');
    await crashed.close();
    const rescuer = new JobRunner({
      queue: queue(double.port),
      pollMs: 25,
      leaseMs: 200,
    });
    cleanup.push(() => rescuer.close());
    const attempts: number[] = [];
    rescuer.register('import', async ({ attempt }) => {
      attempts.push(attempt);
      return { recovered: true };
    });
    rescuer.start();
    await until(
      async () => (await shared.get(leased?.id ?? ''))?.status === 'succeeded',
    );
    // At-least-once: the second attempt ran on the rescuing worker.
    expect(attempts).toEqual([2]);
    expect(await shared.get(leased?.id ?? '')).toMatchObject({
      result: { recovered: true },
    });
  });

  it('never runs, shows or authorizes a tampered record', async () => {
    const double = await server();
    const instance = queue(double.port, 'tamper:');
    const job = record();
    await instance.add(job);
    const key = `tamper:j:${job.id}`;
    const forged = JSON.parse(String(double.values.get(key))) as Record<
      string,
      unknown
    >;
    for (const bad of [
      { ...forged, owner: 'has spaces' },
      { ...forged, status: 'pwned' },
      { ...forged, v: 2 },
      { ...forged, progress: 101 },
      { ...forged, error: 'x'.repeat(300) },
    ]) {
      double.values.set(key, JSON.stringify(bad));
      expect(await instance.get(job.id)).toBeUndefined();
    }
    double.values.set(key, 'not json');
    expect(await instance.get(job.id)).toBeUndefined();
    // Claim quarantines it: removed from the work index, never executed.
    expect(await instance.claim('w', 1000, 0)).toBeUndefined();
    expect(double.values.get('tamper:queued')).toBeUndefined();
    expect(await instance.get('../../etc')).toBeUndefined();
  });

  it('rejects invalid records, prefixes and use after close, and surfaces outages', async () => {
    const double = await server();
    const instance = queue(double.port);
    await expect(instance.add(record({ name: 'Bad Name' }))).rejects.toThrow(
      /Invalid job record/,
    );
    await expect(instance.add({ ...record(), attempts: -1 })).rejects.toThrow(
      /Invalid job record/,
    );
    const duplicate = record();
    await instance.add(duplicate);
    await expect(instance.add(duplicate)).rejects.toThrow(/Duplicate job id/);
    expect(() => new RedisJobQueue({ prefix: 'Bad Prefix' })).toThrow(/prefix/);
    const down = new RedisJobQueue({ port: 1, commandTimeoutMs: 200 });
    cleanup.push(() => down.close());
    await expect(down.get(duplicate.id)).rejects.toThrow();
    await expect(down.claim('w', 1000, 0)).rejects.toThrow();
    await instance.close();
    expect(await instance.claim('w', 1000, 0)).toBeUndefined();
    await expect(instance.get(duplicate.id)).rejects.toThrow(/closed/);
  });
});
