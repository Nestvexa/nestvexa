// Real external service checks (not part of `pnpm test`): Redis pub/sub across
// two processes and a broker restart, the Redis Live state store, the durable
// Redis job queue (including a killed worker process), presence across
// processes with expiry of a killed one, server-action idempotency across
// processes (RedisActionIdempotencyStore), the shared cache store
// (RedisCacheStore), the multi-replica browser acceptance
// suite (Express and Fastify), S3-compatible storage and clamd.
// Each section runs only when its environment variables are present; the
// report records exactly which services were exercised. See
// docs/guides/production-services.md for the Docker commands.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import {
  CircuitOpenError,
  RespRealtimeBroker,
} from '../packages/realtime/dist/index.js';
import {
  RedisLiveStore,
  RespConnection,
} from '../packages/realtime-redis/dist/index.js';
import {
  RedisJobQueue,
  RedisPresenceStore,
} from '../packages/realtime-redis/dist/realtime.js';
import { ClamdScanner, S3Storage } from '../packages/uploads/dist/index.js';

const env = process.env;
const report = {
  timestamp: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  passed: false,
  services: [],
};
const check = async (name, run) => {
  const entry = { name, passed: false, steps: [] };
  report.services.push(entry);
  try {
    await run((step) => entry.steps.push(step));
    entry.passed = true;
    console.log(`${name}: passed (${entry.steps.length} steps)`);
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    console.error(`${name}: FAILED: ${entry.error}`);
  }
};
const waitFor = async (predicate, label, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error('Timed out waiting for ' + label);
};
const text = async (stream) => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

if (env.NESTVEXA_REDIS_PORT)
  await check('redis', async (step) => {
    const port = Number(env.NESTVEXA_REDIS_PORT);
    const prefix = 'nvcheck' + randomBytes(4).toString('hex') + ':';
    // A second OS process subscribes; this process publishes.
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { RespRealtimeBroker } from ${JSON.stringify(new URL('../packages/realtime/dist/index.js', import.meta.url).href)};
const broker = new RespRealtimeBroker({ port: ${port}, prefix: ${JSON.stringify(prefix)} });
await broker.subscribe('board:1', (event) => console.log(JSON.stringify(event.data)));
console.log('"ready"');
process.stdin.on('end', () => broker.close().then(() => process.exit(0)));
process.stdin.resume();`,
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    const lines = [];
    let partial = '';
    child.stdout.on('data', (chunk) => {
      partial += chunk;
      const parts = partial.split('\n');
      partial = parts.pop() ?? '';
      lines.push(...parts.filter(Boolean).map((line) => JSON.parse(line)));
    });
    try {
      // Cold module loading can take tens of seconds on loaded CI hosts.
      await waitFor(
        () => lines.includes('ready'),
        'subscriber process',
        60_000,
      );
      await delay(200);
      const publisher = new RespRealtimeBroker({ port, prefix });
      await publisher.publish('board:1', { revision: 1 });
      await waitFor(
        () => lines.some((line) => line?.revision === 1),
        'cross-process delivery',
      );
      step('cross-process publish delivered to a second Node process');
      if (env.NESTVEXA_REDIS_CONTAINER) {
        const restart = spawnSync(
          'docker',
          ['restart', env.NESTVEXA_REDIS_CONTAINER],
          // Docker Desktop can take minutes on a loaded host.
          { encoding: 'utf8', timeout: 300_000 },
        );
        if (restart.status !== 0)
          throw new Error(
            'docker restart failed: ' +
              (restart.error?.message ?? restart.stderr),
          );
        // Later sections need the server back before they run.
        const ready = new RespConnection({ port, commandTimeoutMs: 2000 });
        const deadline = Date.now() + 120_000;
        while ((await ready.command('PING').catch(() => '')) !== 'PONG') {
          if (Date.now() > deadline)
            throw new Error('Redis did not come back after restart');
          await delay(500);
        }
        await ready.close();
        // Events published while the subscriber is disconnected are lost by
        // design; after reconnecting, new events must flow again.
        let delivered = false;
        const end = Date.now() + 20_000;
        for (let revision = 2; Date.now() < end && !delivered; revision++) {
          await publisher
            .publish('board:1', { revision })
            .catch(() => undefined);
          await delay(250);
          delivered = lines.some((line) => (line?.revision ?? 0) >= 2);
        }
        if (!delivered) throw new Error('No delivery after broker restart');
        step(
          'subscriber resubscribed and received events after a broker restart',
        );
      }
      await publisher.close();
    } finally {
      child.stdin.end();
      child.kill();
    }
  });

/** `docker stop|start <container>`, bounded for a loaded Docker Desktop host. */
const docker = (action, container) => {
  const result = spawnSync('docker', [action, container], {
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (result.status !== 0)
    throw new Error(
      `docker ${action} failed: ` + (result.error?.message ?? result.stderr),
    );
};
/** Wait until a real Redis answers PING again after `docker start`. */
const redisBack = async (port) => {
  const ready = new RespConnection({ port, commandTimeoutMs: 2000 });
  const deadline = Date.now() + 120_000;
  try {
    while ((await ready.command('PING').catch(() => '')) !== 'PONG') {
      if (Date.now() > deadline) throw new Error('Redis did not come back');
      await delay(500);
    }
  } finally {
    await ready.close();
  }
};

// QA-018: the pub/sub broker's circuit breaker against a real Redis that is
// stopped (not restarted) and started again.
if (env.NESTVEXA_REDIS_PORT && env.NESTVEXA_REDIS_CONTAINER)
  await check('redis-broker-breaker', async (step) => {
    const port = Number(env.NESTVEXA_REDIS_PORT);
    const container = env.NESTVEXA_REDIS_CONTAINER;
    const prefix = 'nvbreaker' + randomBytes(4).toString('hex') + ':';
    const subscriber = new RespRealtimeBroker({
      port,
      prefix,
      commandTimeoutMs: 1000,
      circuitBreaker: { failureThreshold: 3, cooldownMs: 1000 },
    });
    const publisher = new RespRealtimeBroker({ port, prefix });
    const received = [];
    try {
      await subscriber.subscribe('board:1', (event) =>
        received.push(event.data),
      );
      await publisher.publish('board:1', { n: 0 });
      await waitFor(() => received.length === 1, 'delivery before the stop');
      docker('stop', container);
      try {
        await waitFor(() => !subscriber.subscribed, 'subscriber disconnect');
        for (let attempt = 0; attempt < 3; attempt++)
          await subscriber.publish('board:1', { n: attempt }).then(
            () => {
              throw new Error('publish succeeded while Redis was stopped');
            },
            (error) => {
              if (error instanceof CircuitOpenError) throw error;
            },
          );
        if (subscriber.circuit !== 'open')
          throw new Error(`circuit is ${subscriber.circuit}, expected open`);
        const started = performance.now();
        for (const attempt of [
          () => subscriber.publish('board:1', 1),
          () => subscriber.ping(),
          () => subscriber.subscribe('board:2', () => undefined),
        ]) {
          const error = await attempt().then(
            () => undefined,
            (caught) => caught,
          );
          if (!(error instanceof CircuitOpenError))
            throw new Error('expected CircuitOpenError while open');
        }
        const elapsed = performance.now() - started;
        if (elapsed > 100)
          throw new Error(`fail-fast took ${Math.round(elapsed)} ms`);
        step(
          'publish, ping and a new subscribe failed fast with CircuitOpenError while Redis was stopped',
        );
      } finally {
        docker('start', container);
      }
      await redisBack(port);
      // The subscriber reconnect after the cooldown is the probe: it closes
      // the circuit and restores the channel without any publish.
      await waitFor(
        () => subscriber.subscribed && subscriber.circuit === 'closed',
        'subscriber reconnect closing the circuit',
        30_000,
      );
      let delivered = false;
      const end = Date.now() + 20_000;
      for (let n = 100; Date.now() < end && !delivered; n++) {
        await publisher.publish('board:1', { n }).catch(() => undefined);
        await delay(200);
        delivered = received.some((data) => (data?.n ?? 0) >= 100);
      }
      if (!delivered) throw new Error('No delivery after Redis started');
      await subscriber.publish('board:1', { n: -1 });
      await subscriber.ping();
      step(
        'after Redis started, the resubscribe probe closed the circuit, delivery resumed and publish/ping succeed',
      );
    } finally {
      await subscriber.close();
      await publisher.close();
    }
  });

// QA-020: examples/distributed-live readiness against a real Redis that is
// stopped and started (liveness must stay up throughout).
if (env.NESTVEXA_REDIS_PORT && env.NESTVEXA_REDIS_CONTAINER)
  await check('distributed-readiness', async (step) => {
    const port = Number(env.NESTVEXA_REDIS_PORT);
    const container = env.NESTVEXA_REDIS_CONTAINER;
    const appPort = Number(env.NESTVEXA_READINESS_PORT ?? 3290);
    const base = `http://127.0.0.1:${appPort}`;
    const child = spawn(process.execPath, ['dist/main.js'], {
      cwd: new URL('../examples/distributed-live/', import.meta.url),
      env: {
        ...env,
        NODE_OPTIONS: '',
        NODE_ENV: 'production',
        PORT: String(appPort),
        REDIS_PORT: String(port),
        REDIS_PREFIX: 'nvready' + randomBytes(4).toString('hex') + ':',
        REALTIME_SECRET: randomBytes(32).toString('base64url'),
        IDENTITY_SECRET: randomBytes(32).toString('base64url'),
      },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const status = (path) =>
      fetch(base + path).then(
        (response) => response.status,
        () => 0,
      );
    const becomes = async (code, ms = 60_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if ((await status('/readyz')) === code) return;
        await delay(250);
      }
      throw new Error(`/readyz did not return ${code}`);
    };
    try {
      await becomes(200, 120_000);
      await fetch(base + '/');
      await becomes(200);
      step('replica ready: /readyz 200 with Redis up');
      docker('stop', container);
      try {
        await becomes(503);
        if ((await status('/healthz')) !== 200)
          throw new Error('/healthz failed while Redis was stopped');
        step('/readyz 503 and /healthz 200 while Redis was stopped');
      } finally {
        docker('start', container);
      }
      await redisBack(port);
      await becomes(200);
      step('/readyz recovered to 200 after Redis started');
    } finally {
      child.kill();
    }
  });

if (env.NESTVEXA_REDIS_PORT)
  await check('redis-live-store', async (step) => {
    const port = Number(env.NESTVEXA_REDIS_PORT);
    const prefix = 'nvstore' + randomBytes(4).toString('hex') + ':';
    const options = {
      host: env.NESTVEXA_REDIS_HOST ?? '127.0.0.1',
      port,
      prefix,
      ...(env.NESTVEXA_REDIS_PASSWORD
        ? { password: env.NESTVEXA_REDIS_PASSWORD }
        : {}),
    };
    const alice = 'tenant-a/session-alice/principal-alice';
    const bob = 'tenant-a/session-bob/principal-bob';
    const a = new RedisLiveStore(options);
    const b = new RedisLiveStore(options);
    const code = async (run) => {
      try {
        await run();
        return 'ok';
      } catch (error) {
        return error?.code ?? error?.message ?? String(error);
      }
    };
    const expect = (actual, expected, label) => {
      if (actual !== expected)
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    };
    try {
      const created = await a.create('counter', alice, { count: 0 });
      const continued = await b.transaction(
        created.snapshot,
        alice,
        0,
        async (snapshot) => ({
          state: { count: snapshot.state.count + 1 },
          html: '<p>1</p>',
        }),
      );
      expect(continued.revision, 1, 'commit on the second store');
      expect((await a.peek(created.snapshot, alice)).state.count, 1, 'read');
      step('state created by one store instance is continued by another');
      const replay = await code(() =>
        a.transaction(created.snapshot, alice, 0, async (s) => ({
          state: s.state,
          html: '',
        })),
      );
      expect(replay, 'STALE_REVISION', 'replayed revision');
      expect(
        await code(() => b.peek(created.snapshot, bob)),
        'INVALID_SNAPSHOT',
        'foreign binding',
      );
      step('replayed revisions and foreign bindings are rejected');
      let release;
      const gate = new Promise((resolve) => (release = resolve));
      const running = a.transaction(created.snapshot, alice, 1, async (s) => {
        await gate;
        return { state: s.state, html: '' };
      });
      await delay(50);
      const busy = await code(() =>
        b.transaction(created.snapshot, alice, 1, async (s) => ({
          state: s.state,
          html: '',
        })),
      );
      release();
      await running;
      expect(busy, 'COMPONENT_BUSY', 'concurrent transaction');
      step(
        'one transaction per entry across store instances (SET NX PX lease)',
      );
      const revoked = await a.create('counter', alice, { count: 0 });
      const interrupted = await code(() =>
        a.transaction(revoked.snapshot, alice, 0, async (s) => {
          await b.revoke(alice);
          return { state: s.state, html: '' };
        }),
      );
      expect(interrupted, 'INVALID_SNAPSHOT', 'revoke during transaction');
      expect(
        await code(() => a.peek(revoked.snapshot, alice)),
        'INVALID_SNAPSHOT',
        'revoked state stays gone',
      );
      step('revoke during a transaction aborts the WATCH/MULTI/EXEC commit');
      const short = new RedisLiveStore({
        ...options,
        ttlMs: 300,
        lockTtlMs: 200,
      });
      const expiring = await short.create('counter', alice, { count: 0 });
      await delay(450);
      expect(
        await code(() => short.peek(expiring.snapshot, alice)),
        'INVALID_SNAPSHOT',
        'TTL expiry',
      );
      const leased = await short.create('counter', alice, { count: 0 });
      const lapsed = await code(() =>
        short.transaction(leased.snapshot, alice, 0, async (s) => {
          await delay(260);
          return { state: s.state, html: '' };
        }),
      );
      expect(lapsed, 'INVALID_SNAPSHOT', 'expired lease');
      await short.close();
      step('Redis PX enforces entry TTL and transaction lease expiry');
    } finally {
      await a.close();
      await b.close();
    }
  });

/** Run a module script in a separate Node process; resolves its stdout lines. */
const child = (source) => {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', source], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const lines = [];
  let partial = '';
  proc.stdout.on('data', (chunk) => {
    partial += chunk;
    const parts = partial.split('\n');
    partial = parts.pop() ?? '';
    lines.push(...parts.filter(Boolean));
  });
  return { proc, lines };
};
const redisOptions = (prefix) => ({
  host: env.NESTVEXA_REDIS_HOST ?? '127.0.0.1',
  port: Number(env.NESTVEXA_REDIS_PORT),
  prefix,
  ...(env.NESTVEXA_REDIS_PASSWORD
    ? { password: env.NESTVEXA_REDIS_PASSWORD }
    : {}),
});
const realtimeRedisUrl = JSON.stringify(
  new URL('../packages/realtime-redis/dist/realtime.js', import.meta.url).href,
);
const realtimeUrl = JSON.stringify(
  new URL('../packages/realtime/dist/index.js', import.meta.url).href,
);

if (env.NESTVEXA_REDIS_PORT)
  await check('redis-live-namespace', async (step) => {
    // DATA-004 on a real server: tenant/user key spaces (SCAN MATCH per
    // tenant), user and tenant revocation, and the attempt fence after a
    // replica process is SIGKILLed while its action callback runs.
    const prefix = 'nvns' + randomBytes(4).toString('hex') + ':';
    const namespace = (binding) => {
      const [tenant, , user] = binding.split('/');
      return { tenant, user };
    };
    const store = new RedisLiveStore({ ...redisOptions(prefix), namespace });
    const scan = new RespConnection(redisOptions(prefix));
    const keys = async (pattern) => {
      const found = [];
      let cursor = '0';
      do {
        const [next, batch] = await scan.command(
          'SCAN',
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          '1000',
        );
        cursor = next;
        found.push(...batch);
      } while (cursor !== '0');
      return found;
    };
    const code = async (run) => {
      try {
        await run();
        return 'ok';
      } catch (error) {
        return error?.code ?? error?.message ?? String(error);
      }
    };
    const expect = (actual, expected, label) => {
      if (actual !== expected)
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    };
    const alice = 'tenant-a/session-1/alice';
    const aliceTwo = 'tenant-a/session-2/alice';
    const carol = 'tenant-b/session-3/carol';
    let worker;
    try {
      const a1 = await store.create('counter', alice, { n: 1 });
      await store.create('counter', aliceTwo, { n: 2 });
      const c1 = await store.create('counter', carol, { n: 3 });
      const tenantA = await keys(`${prefix}t:tenant-a:*`);
      const tenantB = await keys(`${prefix}t:tenant-b:*`);
      expect(
        tenantA.some((key) => key.includes(':s:')),
        true,
        'tenant-a keys',
      );
      expect(tenantB.length > 0, true, 'tenant-b keys');
      const all = (await keys(`${prefix}*`)).join('\n');
      expect(
        all.includes(a1.snapshot) || all.includes('alice'),
        false,
        'raw values in keys',
      );
      step(
        'each tenant has its own key space (SCAN MATCH <prefix>t:<tenant>:*)',
      );
      expect(await store.revokeUser('tenant-a', 'alice'), 2, 'revokeUser');
      expect(
        await code(() => store.peek(a1.snapshot, alice)),
        'INVALID_SNAPSHOT',
        'revoked user',
      );
      expect((await store.peek(c1.snapshot, carol)).state.n, 3, 'other tenant');
      for (let index = 0; index < 100; index++)
        await store.create(
          'counter',
          `tenant-a/session-x${index}/u${index}`,
          {},
        );
      expect(await store.revokeTenant('tenant-a'), 100, 'revokeTenant');
      expect(
        (await keys(`${prefix}t:tenant-a:*`)).length,
        0,
        'tenant-a purged',
      );
      expect(
        (await store.peek(c1.snapshot, carol)).revision,
        0,
        'tenant-b kept',
      );
      step(
        'revokeUser and revokeTenant (100 bindings, batched) delete only their scope',
      );
      // A replica process starts an action and is killed before committing.
      const entry = await store.create('counter', carol, { count: 0 });
      const storeUrl = JSON.stringify(
        new URL('../packages/realtime-redis/dist/index.js', import.meta.url)
          .href,
      );
      worker = child(`import { RedisLiveStore } from ${storeUrl};
const store = new RedisLiveStore({ ...${JSON.stringify(redisOptions(prefix))}, lockTtlMs: 1500, namespace: (b) => { const [tenant, , user] = b.split('/'); return { tenant, user }; } });
await store.transaction(${JSON.stringify(entry.snapshot)}, ${JSON.stringify(carol)}, 0, async (s) => { console.log('running'); await new Promise(() => {}); return { state: s.state, html: '' }; });`);
      await waitFor(
        () => worker.lines.includes('running'),
        'worker action',
        60_000,
      );
      worker.proc.kill('SIGKILL');
      let ran = false;
      const attempt = () =>
        code(() =>
          store.transaction(entry.snapshot, carol, 0, async (s) => {
            ran = true;
            return { state: s.state, html: '' };
          }),
        );
      expect(
        await attempt(),
        'COMPONENT_BUSY',
        'lease held by the killed replica',
      );
      await delay(1700);
      expect(await attempt(), 'INVALID_SNAPSHOT', 'abandoned attempt');
      expect(ran, false, 'callback never re-run');
      step(
        'a SIGKILLed replica mid-action leaves a fence: the entry is invalidated, never retried',
      );
    } finally {
      worker?.proc.kill();
      await store.revokeTenant('tenant-b').catch(() => undefined);
      await store.close();
      await scan.close();
    }
  });

if (env.NESTVEXA_REDIS_PORT)
  await check('redis-live-coordination', async (step) => {
    // LiveActionCoordination on RedisLiveStore (shared idempotent replay and
    // identity locks). Two store instances stand in for two replicas; the
    // browser suite also exercises both through the Live runtime.
    const options = redisOptions(
      'nvcoord' + randomBytes(4).toString('hex') + ':',
    );
    const a = new RedisLiveStore(options);
    const b = new RedisLiveStore(options);
    const key = randomBytes(32).toString('base64url');
    const ownerA = randomBytes(18).toString('base64url');
    const ownerB = randomBytes(18).toString('base64url');
    try {
      await a.writeReplay(key, 'r1.sealed-response', 1500);
      if ((await b.readReplay(key)) !== 'r1.sealed-response')
        throw new Error('replay record written by A not read by B');
      await delay(1700);
      if ((await b.readReplay(key)) !== undefined)
        throw new Error('replay record outlived its PX expiry');
      step(
        'a replay record written on one replica is read on another and expires by PX',
      );
      if (!(await a.acquireActionLease(key, ownerA, 5000)))
        throw new Error('A could not acquire a free lease');
      if (await b.acquireActionLease(key, ownerB, 5000))
        throw new Error('B acquired a lease A holds');
      await a.releaseActionLease(key, ownerA);
      if (!(await b.acquireActionLease(key, ownerB, 800)))
        throw new Error('B could not acquire after A released');
      step(
        'an identity lease held on one replica excludes the other until released',
      );
      // B "crashes" holding the lease: it lapses by PX, then A's late
      // release of a lease it no longer owns must not drop B's successor.
      await delay(1000);
      if (!(await a.acquireActionLease(key, ownerA, 5000)))
        throw new Error('lease of a crashed holder did not expire');
      await b.releaseActionLease(key, ownerB);
      if (await b.acquireActionLease(key, ownerB, 5000))
        throw new Error('a stale owner released the current lease');
      step(
        "a crashed holder's lease expires; a stale owner cannot release the new owner's lease",
      );
    } finally {
      await a.close();
      await b.close();
    }
  });

if (env.NESTVEXA_REDIS_PORT)
  await check('redis-job-queue', async (step) => {
    const { JobRunner } = await import('../packages/realtime/dist/index.js');
    const prefix = 'nvjobs' + randomBytes(4).toString('hex') + ':';
    const options = redisOptions(prefix);
    const owner = { binding: 'tenant-a/session-alice/principal-alice' };
    const other = { binding: 'tenant-a/session-bob/principal-bob' };
    // This process enqueues but stays saturated by a blocker job, so the
    // report job is claimed by the worker process. Leases are 3 s: with 1 s a
    // loaded host can miss a renewal and the worker reclaims its own job.
    const enqueuer = new JobRunner({
      queue: new RedisJobQueue(options),
      concurrency: 1,
      leaseMs: 3000,
    });
    enqueuer.register(
      'block',
      ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('stop'))),
        ),
    );
    enqueuer.register('report', async () => null);
    let worker;
    let rescuer;
    try {
      const blocker = await enqueuer.enqueue(owner, 'block');
      for (let tries = 0; tries < 200; tries++) {
        if ((await enqueuer.get(owner, blocker.id))?.status === 'running')
          break;
        await delay(25);
      }
      // A worker process that claims the report, reports progress, then
      // hangs until it is killed (a crash: no shutdown hand-back).
      worker = child(`import { JobRunner } from ${realtimeUrl};
import { RedisJobQueue } from ${realtimeRedisUrl};
const runner = new JobRunner({ queue: new RedisJobQueue(${JSON.stringify(options)}), pollMs: 50, leaseMs: 3000 });
runner.register('report', async ({ progress, attempt }) => {
  progress(30);
  console.log('running ' + attempt);
  await new Promise(() => undefined);
});
runner.start();
console.log('ready');`);
      await waitFor(() => worker.lines.includes('ready'), 'worker', 60_000);
      const job = await enqueuer.enqueue(owner, 'report', {
        input: { month: '2026-11' },
        idempotencyKey: 'report:2026-11',
        maxAttempts: 1,
      });
      await waitFor(
        () => worker.lines.includes('running 1'),
        'worker claims the job',
        20_000,
      );
      const running = await enqueuer.get(owner, job.id);
      if (running?.status !== 'running')
        throw new Error('expected running, got ' + running?.status);
      step('a job enqueued in this process is claimed by a worker process');
      const again = await enqueuer.enqueue(owner, 'report', {
        input: { month: '2026-11' },
        idempotencyKey: 'report:2026-11',
      });
      if (again.id !== job.id)
        throw new Error('idempotency key created a second job');
      if (await enqueuer.get(other, job.id))
        throw new Error('another identity read the job');
      step('idempotency key and ownership hold across processes');
      worker.proc.kill('SIGKILL');
      // The killed worker's lease lapses; a new runner takes the job over.
      rescuer = new JobRunner({
        queue: new RedisJobQueue(options),
        leaseMs: 3000,
        pollMs: 50,
      });
      rescuer.register('report', async ({ attempt, input }) => ({
        rescuedOnAttempt: attempt,
        input,
      }));
      rescuer.register('block', async () => null);
      rescuer.start();
      const deadline = Date.now() + 20_000;
      let finished;
      while (Date.now() < deadline) {
        finished = await rescuer.get(owner, job.id);
        if (finished?.status === 'succeeded') break;
        await delay(100);
      }
      if (finished?.status !== 'succeeded')
        throw new Error('job not recovered: ' + JSON.stringify(finished));
      if (finished.attempts !== 2 || finished.result?.rescuedOnAttempt !== 2)
        throw new Error('unexpected recovery: ' + JSON.stringify(finished));
      step(
        'after SIGKILL of the worker process the lapsed lease is reclaimed and the job completes (attempt 2)',
      );
    } finally {
      worker?.proc.kill('SIGKILL');
      await enqueuer.close();
      await rescuer?.close();
    }
  });

if (env.NESTVEXA_REDIS_PORT)
  await check('redis-presence', async (step) => {
    const prefix = 'nvpresence' + randomBytes(4).toString('hex') + ':';
    const options = redisOptions(prefix);
    const store = new RedisPresenceStore(options);
    // Another process publishes its members with a 1.5 s TTL every 400 ms.
    const replica =
      child(`import { RedisPresenceStore } from ${realtimeRedisUrl};
const store = new RedisPresenceStore(${JSON.stringify(options)});
const write = () => store.write('replica-child-0001', 'tenant-a:room', { members: [{ id: 'u-bob' }], total: 1 }, 1500);
await write();
setInterval(write, 400);
console.log('ready');`);
    try {
      await waitFor(
        () => replica.lines.includes('ready'),
        'presence process',
        60_000,
      );
      await store.write(
        'replica-self-00001',
        'tenant-a:room',
        { members: [{ id: 'u-alice' }], total: 1 },
        30_000,
      );
      const both = await store.read('tenant-a:room');
      const ids = both.flatMap((entry) => entry.members.map((m) => m.id));
      if (!(ids.includes('u-alice') && ids.includes('u-bob')))
        throw new Error('expected both replicas: ' + JSON.stringify(both));
      await delay(2000);
      if ((await store.read('tenant-a:room')).length !== 2)
        throw new Error('a live replica lapsed while refreshing');
      step('entries from two processes are merged and refreshed under TTL');
      replica.proc.kill('SIGKILL');
      await delay(2000);
      const after = await store.read('tenant-a:room');
      if (after.length !== 1 || after[0]?.replica !== 'replica-self-00001')
        throw new Error(
          'killed replica still present: ' + JSON.stringify(after),
        );
      step('a SIGKILLed replica drops out after its PX expiry');
      await store.remove('replica-self-00001', 'tenant-a:room');
      if ((await store.read('tenant-a:room')).length)
        throw new Error('entry survived remove');
      step('graceful remove deletes the entry immediately');
    } finally {
      replica.proc.kill('SIGKILL');
      await store.close();
    }
  });

if (env.NESTVEXA_REDIS_PORT)
  await check('redis-action-idempotency', async (step) => {
    // Server-action idempotency across replicas and processes (REVIEW-016):
    // RedisActionIdempotencyStore claims, leases, replays and fails closed.
    const { RedisActionIdempotencyStore } =
      await import('../packages/realtime-redis/dist/actions.js');
    const options = redisOptions(
      'nvidem' + randomBytes(4).toString('hex') + ':',
    );
    const hex = () => randomBytes(32).toString('hex');
    const fingerprint = hex();
    const a = new RedisActionIdempotencyStore(options);
    const b = new RedisActionIdempotencyStore(options);
    const actionsUrl = JSON.stringify(
      new URL('../packages/realtime-redis/dist/actions.js', import.meta.url)
        .href,
    );
    let worker;
    try {
      const key = hex();
      const outcome = { data: { charged: 5 } };
      const status = async (store, claim) =>
        (await store.begin(claim, fingerprint, 60_000)).status;
      if ((await status(a, key)) !== 'started')
        throw new Error('A could not claim a free key');
      if ((await status(b, key)) !== 'in-progress')
        throw new Error('B claimed a key A holds');
      await a.complete(key, outcome);
      const replay = await b.begin(key, fingerprint, 60_000);
      if (
        replay.status !== 'replay' ||
        JSON.stringify(replay.outcome) !== JSON.stringify(outcome)
      )
        throw new Error('B did not replay the outcome A stored');
      if ((await b.begin(key, hex(), 60_000)).status !== 'mismatch')
        throw new Error('a different input was not a mismatch');
      step(
        'a claim on one replica blocks the other; its outcome replays there; other input is a mismatch',
      );
      // Another OS process claims a key and completes it, then a second
      // claim and is SIGKILLed before completing.
      const done = hex();
      const crashed = hex();
      worker = child(`import { RedisActionIdempotencyStore } from ${actionsUrl};
const store = new RedisActionIdempotencyStore({ ...${JSON.stringify(options)}, leaseMs: 1000 });
await store.begin(${JSON.stringify(done)}, ${JSON.stringify(fingerprint)}, 60000);
await store.complete(${JSON.stringify(done)}, { data: { pid: process.pid } });
await store.begin(${JSON.stringify(crashed)}, ${JSON.stringify(fingerprint)}, 60000);
console.log('claimed');
setInterval(() => undefined, 1000);`);
      await waitFor(
        () => worker.lines.includes('claimed'),
        'idempotency process',
        60_000,
      );
      const fromChild = await a.begin(done, fingerprint, 60_000);
      if (
        fromChild.status !== 'replay' ||
        fromChild.outcome.data.pid !== worker.proc.pid
      )
        throw new Error('the outcome stored by another process did not replay');
      await delay(2000);
      if ((await status(a, crashed)) !== 'in-progress')
        throw new Error('a live claim was not renewed');
      worker.proc.kill('SIGKILL');
      await delay(1500);
      if ((await status(a, crashed)) !== 'started')
        throw new Error('the claim of a killed process did not lapse');
      step(
        "another process's outcome replays here; its renewed claim holds, and lapses after one lease once it is killed",
      );
      const short = hex();
      await a.begin(short, fingerprint, 1000);
      await a.complete(short, outcome);
      await delay(1300);
      if ((await status(b, short)) !== 'started')
        throw new Error('a completed record outlived its TTL');
      step('completed records expire by PX after the runtime TTL');
      const down = new RedisActionIdempotencyStore({
        ...options,
        port: 1,
        circuitBreaker: false,
        commandTimeoutMs: 500,
      });
      const failure = await down.begin(hex(), fingerprint, 60_000).then(
        () => undefined,
        (error) => error,
      );
      await down.close();
      if (failure?.message !== 'Action idempotency store is unavailable')
        throw new Error('an unreachable Redis did not fail closed');
      step('an unreachable Redis fails the claim (closed), never "started"');
    } finally {
      worker?.proc.kill('SIGKILL');
      await a.close();
      await b.close();
    }
  });

if (env.NESTVEXA_REDIS_PORT)
  await check('redis-cache-store', async (step) => {
    // Shared cache (REL-013 / REVIEW-017): tags, invalidation visible across
    // instances, cross-process stampede lock, refusal and size bounds.
    const { Cache, CacheRefusedError } =
      await import('../packages/cache/dist/index.js');
    const { RedisCacheStore } =
      await import('../packages/realtime-redis/dist/cache.js');
    const prefix = 'nvcache' + randomBytes(4).toString('hex') + ':';
    const options = redisOptions(prefix);
    const storeA = new RedisCacheStore(options);
    const storeB = new RedisCacheStore(options);
    const scan = new RespConnection(options);
    const a = new Cache({ store: storeA });
    const b = new Cache({ store: storeB });
    const parts = {
      namespace: 'data:products',
      scope: { kind: 'tenant', tenant: 'tenant-a' },
    };
    const config = { ttlMs: 60_000, tags: ['products:tenant-a'] };
    try {
      let runs = 0;
      const load = async () => {
        runs++;
        await delay(200);
        return { runs };
      };
      const [first, second] = await Promise.all([
        a.lookup(parts, config, load),
        delay(30).then(() => b.lookup(parts, config, load)),
      ]);
      if (
        runs !== 1 ||
        first.status !== 'miss' ||
        second.status !== 'coalesced'
      )
        throw new Error(
          `stampede lock: ${runs} runs, ${first.status}/${second.status}`,
        );
      if ((await b.lookup(parts, config, load)).status !== 'hit')
        throw new Error('B did not hit the entry A stored');
      step(
        'concurrent misses on two instances compute once (Redis lock); the other instance hits',
      );
      if ((await b.invalidate(['products:tenant-a'])) !== 1)
        throw new Error('invalidation did not remove the shared entry');
      const after = await a.lookup(parts, config, load);
      if (after.status !== 'miss' || runs !== 2)
        throw new Error('an invalidation on B was not visible on A');
      step('an invalidation on one instance is visible on the other at once');
      await storeA.set('ttl', {
        value: 1,
        expiresAt: Date.now() + 500,
        staleUntil: Date.now() + 500,
        tags: [],
      });
      await delay(700);
      if ((await storeB.get('ttl')) !== undefined)
        throw new Error('an entry outlived its PX expiry');
      step('entries expire by PX at staleUntil');
      const refused = await storeA
        .set('signed', {
          value: '<div data-nv-snapshot="x"></div>',
          expiresAt: Date.now() + 60_000,
          staleUntil: Date.now() + 60_000,
          tags: [],
        })
        .then(
          () => undefined,
          (error) => error,
        );
      if (!(refused instanceof CacheRefusedError))
        throw new Error('a Live snapshot was not refused');
      const bounded = new RedisCacheStore({
        ...options,
        prefix: prefix + 'b:',
        maxEntries: 3,
      });
      for (let index = 0; index < 5; index++)
        await bounded.set(`k${index}`, {
          value: index,
          expiresAt: Date.now() + 10_000 + index * 1000,
          staleUntil: Date.now() + 10_000 + index * 1000,
          tags: [],
        });
      const size = Number(await scan.command('ZCARD', `${prefix}b:i`));
      await bounded.close();
      if (size !== 3) throw new Error(`index holds ${size} entries, not 3`);
      const keys = await scan.command('KEYS', `${prefix}*`);
      if (
        !Array.isArray(keys) ||
        keys.some((key) => key.includes('tenant-a') && key.includes(':e:'))
      )
        throw new Error('raw cache keys reached Redis');
      step(
        'signed values are refused before Redis; maxEntries bounds the index; keys are hashed',
      );
    } finally {
      await storeA.close();
      await storeB.close();
      await scan.close();
    }
  });

if (env.NESTVEXA_REDIS_PORT && env.NESTVEXA_SERVICES_BROWSER !== '0')
  await check('redis-replicas-browser', async (step) => {
    // Four example replicas (Express and Fastify, SSE and WebSocket) behind
    // a proxy, one Redis.
    // A constant command line (nothing interpolated) through the shell, so
    // pnpm's Windows .cmd shim resolves.
    const run = spawnSync(
      'pnpm exec playwright test -c playwright.services.config.ts --project=chromium',
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        // Five servers start before the tests; a loaded host needs minutes.
        timeout: 1_800_000,
        env,
      },
    );
    process.stdout.write(run.stdout ?? '');
    process.stderr.write(run.stderr ?? '');
    if (run.status !== 0)
      throw new Error(
        `playwright.services.config.ts exited with ${run.status}`,
      );
    const passed = /(\d+) passed/.exec(run.stdout ?? '')?.[1] ?? '?';
    step(
      `${passed} browser tests passed: cross-replica refresh over SSE and WebSocket on Express and Fastify; Live state continues across replicas and adapters; idempotent retry replays on another replica; identity lock held across replicas and released; cross-identity isolation; presence across four replicas; reconnect after a dropped load balancer without duplicates; no leaked connections; showcase on two instances (cross-instance dashboard refresh and notifications, workspace isolation)`,
    );
  });

if (env.NESTVEXA_S3_ENDPOINT)
  await check('s3', async (step) => {
    const storage = new S3Storage({
      endpoint: env.NESTVEXA_S3_ENDPOINT,
      region: env.NESTVEXA_S3_REGION ?? 'us-east-1',
      bucket: env.NESTVEXA_S3_BUCKET ?? 'nestvexa-check',
      credentials: {
        accessKeyId: env.NESTVEXA_S3_ACCESS_KEY ?? '',
        secretAccessKey: env.NESTVEXA_S3_SECRET_KEY ?? '',
      },
    });
    const directory = await mkdtemp(join(tmpdir(), 'nestvexa-s3-'));
    try {
      const body = 'hello object storage ' + randomBytes(8).toString('hex');
      const path = join(directory, 'file.txt');
      await writeFile(path, body);
      const key =
        randomBytes(2).toString('base64url').slice(0, 2) +
        '/' +
        randomBytes(32).toString('base64url').slice(0, 43);
      const stored = await storage.put(key, {
        path,
        size: Buffer.byteLength(body),
        sha256: createHash('sha256').update(body).digest('hex'),
        contentType: 'text/plain',
      });
      if (stored.size !== Buffer.byteLength(body)) throw new Error('size');
      step('signed PUT');
      if ((await storage.stat(key))?.size !== stored.size)
        throw new Error('stat size mismatch');
      step('signed HEAD');
      if ((await text(await storage.open(key))) !== body)
        throw new Error('GET body mismatch');
      if (
        (await text(await storage.open(key, { start: 0, end: 4 }))) !== 'hello'
      )
        throw new Error('ranged GET mismatch');
      step('signed GET and Range GET');
      const url = await storage.presignDownload(key, {
        filename: 'report.txt',
        contentType: 'text/plain',
      });
      const download = await fetch(url);
      if (!download.ok || (await download.text()) !== body)
        throw new Error('presigned GET failed: ' + download.status);
      if (!/attachment/.test(download.headers.get('content-disposition') ?? ''))
        throw new Error('presigned GET lacks attachment disposition');
      step('presigned GET with attachment disposition');
      const directKey =
        key.slice(0, 3) + randomBytes(32).toString('base64url').slice(0, 43);
      const target = await storage.presignUpload(directKey, {
        contentType: 'text/plain',
        size: 5,
        expiresInSeconds: 60,
      });
      const put = await fetch(target.url, {
        method: 'PUT',
        headers: target.headers,
        body: 'direct',
      });
      if (put.ok) throw new Error('presigned PUT accepted a wrong length');
      const ok = await fetch(target.url, {
        method: 'PUT',
        headers: target.headers,
        body: 'bytes',
      });
      if (!ok.ok) throw new Error('presigned PUT failed: ' + ok.status);
      step('presigned PUT enforces the signed length');
      await storage.delete(key);
      await storage.delete(directKey);
      if (await storage.stat(key)) throw new Error('object survived delete');
      step('signed DELETE');
      const forged = new S3Storage({
        endpoint: env.NESTVEXA_S3_ENDPOINT,
        region: env.NESTVEXA_S3_REGION ?? 'us-east-1',
        bucket: env.NESTVEXA_S3_BUCKET ?? 'nestvexa-check',
        credentials: {
          accessKeyId: env.NESTVEXA_S3_ACCESS_KEY ?? '',
          secretAccessKey: 'wrong-secret',
        },
      });
      const accepted = await forged
        .put(key, {
          path,
          size: Buffer.byteLength(body),
          sha256: createHash('sha256').update(body).digest('hex'),
          contentType: 'text/plain',
        })
        .then(
          () => true,
          () => false,
        );
      if (accepted)
        throw new Error('server accepted a request signed with a wrong secret');
      step('request signed with a wrong secret is rejected');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

if (env.NESTVEXA_CLAMD_PORT)
  await check('clamd', async (step) => {
    const scanner = new ClamdScanner({
      host: env.NESTVEXA_CLAMD_HOST ?? '127.0.0.1',
      port: Number(env.NESTVEXA_CLAMD_PORT),
      timeoutMs: 60_000,
    });
    const scan = (bytes) =>
      scanner.scan(
        {
          name: 'file.txt',
          contentType: 'text/plain',
          size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          open: async () => Readable.from([bytes]),
        },
        AbortSignal.timeout(60_000),
      );
    const clean = await scan(Buffer.from('plain business document'));
    if (clean.status !== 'clean')
      throw new Error('clean file: ' + JSON.stringify(clean));
    step('clean file reported clean');
    // The industry-standard EICAR antivirus test string (harmless by design).
    const eicar = Buffer.from(
      'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*',
    );
    const infected = await scan(eicar);
    if (infected.status !== 'infected')
      throw new Error('EICAR file: ' + JSON.stringify(infected));
    step('EICAR test file reported infected: ' + (infected.signature ?? ''));
  });

report.passed =
  report.services.length > 0 && report.services.every((s) => s.passed);
await mkdir('artifacts/reports', { recursive: true });
await writeFile(
  'artifacts/reports/services.json',
  JSON.stringify(report, null, 2),
);
if (!report.services.length)
  console.error(
    'No service configured: set NESTVEXA_REDIS_PORT, NESTVEXA_S3_ENDPOINT or NESTVEXA_CLAMD_PORT.',
  );
if (!report.passed) process.exitCode = 1;
