// Real external service checks (not part of `pnpm test`): Redis pub/sub across
// two processes and a broker restart, the Redis Live state store, the
// two-replica browser acceptance suite, S3-compatible storage and clamd.
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
import { RespRealtimeBroker } from '../packages/realtime/dist/index.js';
import { RedisLiveStore } from '../packages/realtime-redis/dist/index.js';
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
          { encoding: 'utf8', timeout: 60_000 },
        );
        if (restart.status !== 0)
          throw new Error('docker restart failed: ' + restart.stderr);
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

if (env.NESTVEXA_REDIS_PORT && env.NESTVEXA_SERVICES_BROWSER !== '0')
  await check('redis-two-replicas-browser', async (step) => {
    // Two example replicas (SSE and WebSocket) behind a proxy, one Redis.
    // A constant command line (nothing interpolated) through the shell, so
    // pnpm's Windows .cmd shim resolves.
    const run = spawnSync(
      'pnpm exec playwright test -c playwright.services.config.ts --project=chromium',
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        timeout: 900_000,
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
      `${passed} browser tests passed: replica B publish refreshes a browser on replica A (SSE) and back (WebSocket); Live state created on A continues on B; cross-identity isolation on both replicas`,
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
