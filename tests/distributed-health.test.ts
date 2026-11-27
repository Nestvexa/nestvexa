/**
 * Liveness and readiness probes of examples/distributed-live (QA-020). The
 * replica runs as a real production process (built `dist/main.js`) on Express
 * and on Fastify against the in-process RESP double. Stopping the double
 * stands in for a Redis outage: `/readyz` must turn 503 while `/healthz`
 * stays 200, and `/readyz` must recover once Redis is back on the same port.
 * `pnpm test:services` repeats the scenario against a real Redis container
 * that is stopped and started.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { respDouble } from './support/resp-double.js';
import type { RespDouble } from './support/resp-double.js';

const root = fileURLToPath(
  new URL('../examples/distributed-live/', import.meta.url),
);
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A port that is free right now (the OS picks it, then it is released). */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === 'string') throw new Error('No port');
  return address.port;
}

async function replica(
  adapter: 'express' | 'fastify',
  redisPort: number,
): Promise<{ base: string; logs: () => string }> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ['dist/main.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: '',
      NODE_ENV: 'production',
      PORT: String(port),
      HTTP_ADAPTER: adapter,
      REDIS_PORT: String(redisPort),
      REDIS_PREFIX: 'nvhealth:',
      REALTIME_SECRET: 'health-realtime-secret-0123456789abcdef',
      IDENTITY_SECRET: 'health-identity-secret-0123456789abcdef',
      READINESS_TIMEOUT_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout?.on('data', (chunk: Buffer) => (logs += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (logs += chunk.toString()));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      }),
  );
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && child.exitCode === null) {
    const up = await fetch(`${base}/healthz`).then(
      (response) => response.ok,
      () => false,
    );
    if (up) return { base, logs: () => logs };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`replica did not start:\n${logs}`);
}

async function probe(url: string) {
  const response = await fetch(url);
  return {
    status: response.status,
    cache: response.headers.get('cache-control'),
    body: (await response.json()) as Record<string, unknown>,
  };
}
/** Poll `/readyz` until it reports `status` (the breaker and resubscribe backoff take a few seconds). */
async function readyzBecomes(base: string, status: number, ms = 30_000) {
  const end = Date.now() + ms;
  let last = await probe(`${base}/readyz`);
  while (last.status !== status && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    last = await probe(`${base}/readyz`);
  }
  expect(last.status).toBe(status);
  return last;
}

describe.each(['express', 'fastify'] as const)(
  'distributed-live readiness on %s',
  (adapter) => {
    it('fails readiness (not liveness) while Redis is down and recovers', async () => {
      let redis: RespDouble = await respDouble();
      cleanups.push(() => redis.close());
      const port = redis.port;
      const server = await replica(adapter, port);

      const live = await probe(`${server.base}/healthz`);
      expect(live).toMatchObject({
        status: 200,
        cache: 'no-store',
        body: { status: 'ok' },
      });
      // The page subscribes the broker to the board channel, so readiness
      // also covers the subscriber connection.
      expect((await fetch(`${server.base}/`)).status).toBe(200);
      const ready = await readyzBecomes(server.base, 200);
      expect(ready.cache).toBe('no-store');
      expect(ready.body).toMatchObject({
        status: 'ready',
        checks: { store: 'ok', broker: 'ok' },
      });

      // Redis goes away: every connection is reset and the port refuses.
      await redis.close();
      const down = await readyzBecomes(server.base, 503);
      expect(down.body).toMatchObject({ status: 'unready' });
      const checks = down.body['checks'];
      expect(checks).toMatchObject({ store: 'unavailable' });
      expect(['unavailable', 'resubscribing']).toContain(
        Reflect.get(Object(checks), 'broker'),
      );
      // Probes stay fast while the circuits are open (no hung requests).
      const started = performance.now();
      expect((await probe(`${server.base}/readyz`)).status).toBe(503);
      expect(performance.now() - started).toBeLessThan(1_500);
      // Liveness ignores dependencies: restarting cannot fix Redis.
      expect((await probe(`${server.base}/healthz`)).status).toBe(200);

      // Redis comes back on the same port: readiness recovers on its own.
      redis = await respDouble({ port });
      const recovered = await readyzBecomes(server.base, 200);
      expect(recovered.body).toMatchObject({
        status: 'ready',
        checks: { store: 'ok', broker: 'ok' },
      });
      expect(server.logs()).not.toMatch(/Unhandled|uncaught/i);
    }, 180_000);
  },
);
