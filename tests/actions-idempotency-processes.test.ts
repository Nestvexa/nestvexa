import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { respDouble } from './support/resp-double.js';
import type { RespDouble } from './support/resp-double.js';

/**
 * Server-action idempotency across OS processes: each process is a separate
 * Nest application with its own `RedisActionIdempotencyStore`, sharing one
 * RESP server. The handler counts its side effects in Redis, so the test sees
 * exactly how often it ran across processes and restarts.
 */
const origin = 'http://localhost:4280';
const csrf = 'alice-csrf-token-0123456789abcdef';
const ports = { a: 4281, b: 4282, redis: 4283 };
const url = (path: string) =>
  JSON.stringify(new URL(`../packages/${path}`, import.meta.url).href);

function worker(port: number, redisPort: number): string {
  return `import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ActionContext, ActionGroup, ActionInput, ActionsModule, ServerAction } from ${url('actions/dist/index.js')};
import { RedisActionIdempotencyStore } from ${url('realtime-redis/dist/actions.js')};
// resp.js directly: the root entry would also load @nestvexa/live.
import { RespConnection } from ${url('realtime-redis/dist/resp.js')};
const effects = new RespConnection({ port: ${redisPort} });
class Cart {
  async pay(input, context) {
    const charge = await effects.command('INCR', 'effects');
    if (input.holdMs) await new Promise((resolve) => setTimeout(resolve, input.holdMs));
    return { charged: input.amount, charge: Number(charge), pid: process.pid, subject: context.identity.subject };
  }
}
ActionInput()(Cart.prototype, 'pay', 0);
ActionContext()(Cart.prototype, 'pay', 1);
Object.defineProperty(Cart.prototype, 'pay', Reflect.decorate(
  [ServerAction({ id: 'pay', idempotent: true })],
  Cart.prototype, 'pay', Object.getOwnPropertyDescriptor(Cart.prototype, 'pay'),
));
ActionGroup('cart')(Cart);
const store = new RedisActionIdempotencyStore({ port: ${redisPort}, leaseMs: 5000 });
class AppModule {}
Module({ imports: [ActionsModule.register({
  groups: [Cart],
  origin: ${JSON.stringify(origin)},
  idempotency: { store },
  resolveIdentity: (request) => request.headers['x-session'] === 'alice'
    ? { subject: 'user-alice', tenant: 'acme', csrfToken: ${JSON.stringify(csrf)} }
    : null,
  authorize: () => true,
})] })(AppModule);
const app = await NestFactory.create(AppModule, { logger: false });
await app.listen(${port}, '127.0.0.1');
console.log('ready');`;
}

const children = new Set<ChildProcess>();
let double: RespDouble | undefined;
afterEach(async () => {
  for (const child of children) child.kill('SIGKILL');
  children.clear();
  await double?.close();
  double = undefined;
});

async function start(port: number): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', worker(port, ports.redis)],
    { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.add(child);
  let errors = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    errors += chunk.toString('utf8');
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Worker did not start: ${errors}`)),
      // A loaded CI machine can take a while to boot a Nest process.
      180_000,
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('ready')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Worker exited with ${String(code)}: ${errors}`));
    });
  });
  return child;
}
async function stop(child: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
  children.delete(child);
}

interface Reply {
  status: number;
  replayed: boolean;
  data: { charged?: number; charge?: number; pid?: number } | undefined;
  reason: string | undefined;
}
function pay(port: number, key: string, input: object): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `http://127.0.0.1:${port}/_nestvexa/actions/cart/pay`,
      {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          'x-session': 'alice',
          'x-nestvexa-csrf': csrf,
          'idempotency-key': key,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('error', reject);
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            data?: Reply['data'];
            error?: { reason?: string };
          };
          resolve({
            status: response.statusCode ?? 0,
            replayed: response.headers['idempotent-replayed'] === 'true',
            data: body.data,
            reason: body.error?.reason,
          });
        });
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify({ input }));
  });
}
const effects = () => Number(double?.values.get('effects') ?? 0);
async function until(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 60_000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('server-action idempotency across processes (RedisActionIdempotencyStore)', () => {
  it('runs the handler once across processes, restarts and concurrent retries, and recovers a crashed claim after its lease', async () => {
    double = await respDouble({ port: ports.redis });
    let a = await start(ports.a);
    const b = await start(ports.b);

    // Run on process A, retry on process B: B replays A's result.
    const key = 'payment-key-process-0000001';
    const first = await pay(ports.a, key, { amount: 5 });
    expect(first.status).toBe(200);
    expect(first.replayed).toBe(false);
    expect(first.data?.pid).toBe(a.pid);
    const retry = await pay(ports.b, key, { amount: 5 });
    expect(retry.status).toBe(200);
    expect(retry.replayed).toBe(true);
    expect(retry.data).toEqual(first.data);
    expect(effects()).toBe(1);

    // Restart A: the new process still replays (records live in Redis).
    await stop(a);
    a = await start(ports.a);
    const afterRestart = await pay(ports.a, key, { amount: 5 });
    expect(afterRestart.replayed).toBe(true);
    expect(afterRestart.data).toEqual(first.data);
    expect(effects()).toBe(1);

    // A duplicate on B while A is still running is rejected, then replays.
    const slow = 'payment-key-process-0000002';
    const running = pay(ports.a, slow, { amount: 7, holdMs: 1500 });
    await until(() => effects() === 2, 'the handler on A');
    const duplicate = await pay(ports.b, slow, { amount: 7, holdMs: 1500 });
    expect(duplicate.status).toBe(409);
    expect(duplicate.reason).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect((await running).status).toBe(200);
    const replayed = await pay(ports.b, slow, { amount: 7, holdMs: 1500 });
    expect(replayed.replayed).toBe(true);
    expect(effects()).toBe(2);

    // A different input under the same key is a mismatch on any process.
    const mismatch = await pay(ports.b, key, { amount: 6 });
    expect(mismatch.status).toBe(409);
    expect(mismatch.reason).toBe('IDEMPOTENCY_MISMATCH');
    expect(effects()).toBe(2);

    // A process killed mid-handler: its claim blocks retries until one lease
    // (5 s) passes without renewal, then a retry runs (no outcome was stored).
    const crashed = 'payment-key-process-0000003';
    const input = { amount: 9, holdMs: 30_000 };
    void pay(ports.a, crashed, input).catch(() => undefined);
    await until(() => effects() === 3, 'the handler on A');
    await stop(a);
    // Within the lease the claim still blocks a retry.
    const blocked = await pay(ports.b, crashed, input);
    expect(blocked.status).toBe(409);
    expect(blocked.reason).toBe('IDEMPOTENCY_IN_PROGRESS');
    await new Promise((resolve) => setTimeout(resolve, 5500));
    // The retry holds for 30 s; B is killed once it has started.
    const recovered = pay(ports.b, crashed, input).catch(() => undefined);
    await until(() => effects() === 4, 'the retry on B');
    await stop(b);
    await recovered;
  }, 600_000);
});
