/**
 * Server-side memory bounds for Live mounts (QA-007): thousands of mounts in
 * one process, each for a fresh identity, through the real `LiveRuntime` and a
 * production-configured (cached) Handlebars renderer. The default memory store
 * must fail closed at its entry budget and recover once entries expire,
 * revocation must release every entry, and the heap retained after a forced
 * full GC must not grow with the number of mounts.
 */
import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  LiveComponent,
  LiveModule,
  LiveRuntime,
  MemoryLiveStore,
  State,
} from '../packages/live/dist/index.js';

@LiveComponent({ name: 'memory-counter', view: 'counter' })
class Counter {
  @State() count = 0;
  @State() label = 'counter';
  @State() items: string[] = ['a', 'b', 'c'];
}

// Expose V8's collector for this worker only; the flag must precede the call.
setFlagsFromString('--expose-gc');
const collect: unknown = runInNewContext('gc');
function retainedHeap(): number {
  if (typeof collect !== 'function') throw new Error('gc() is unavailable');
  for (let pass = 0; pass < 3; pass++) collect();
  return process.memoryUsage().heapUsed;
}

const MiB = 1024 * 1024;
const origin = 'http://localhost:3820';
const csrf = 'memory-fixture-csrf-0123456789012345678901234567890';
const binding = (index: number): string =>
  `memory-session-${String(index).padStart(8, '0')}`;

const resources: { root: string; engine: HbsEngine; app: INestApplication }[] =
  [];
afterEach(async () => {
  vi.useRealTimers();
  for (const { root, engine, app } of resources.splice(0)) {
    await app.close();
    await engine.dispose();
    // Only directories created by this suite under the OS temp root are removed.
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !root.includes('nestvexa-live-memory-')
    )
      throw new Error('Unsafe fixture cleanup path');
    await rm(root, { recursive: true, force: true });
  }
});

async function boot(store: MemoryLiveStore): Promise<LiveRuntime> {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-live-memory-'));
  await writeFile(
    join(root, 'counter.hbs'),
    '<p>{{count}} {{label}}</p><ul>{{#each items}}<li>{{this}}</li>{{/each}}</ul>',
  );
  const engine = new HbsEngine({ root, cache: true });
  await engine.initialize();
  const module = await Test.createTestingModule({
    imports: [
      LiveModule.registerAsync({
        components: [Counter],
        useFactory: () => ({
          renderer: engine,
          origin,
          store,
          resolveIdentity: (request: object) => ({
            binding: String(Reflect.get(request, 'binding')),
            csrfToken: csrf,
          }),
          authorize: () => true,
        }),
      }),
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  resources.push({ root, engine, app });
  await app.init();
  return app.get(LiveRuntime);
}

async function mount(runtime: LiveRuntime, index: number): Promise<string> {
  return (
    await runtime.mount(Counter, { headers: {}, binding: binding(index) })
  ).value;
}
async function mountRange(
  runtime: LiveRuntime,
  from: number,
  to: number,
): Promise<void> {
  for (let index = from; index < to; index++)
    if (!(await mount(runtime, index)).includes('data-nv-snapshot='))
      throw new Error('Mount failed');
}
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    const response = error.getResponse();
    return {
      status: error.getStatus(),
      code:
        typeof response === 'object' && response !== null
          ? Reflect.get(response, 'code')
          : response,
    };
  }
  throw new Error('Expected the mount to be rejected');
}

describe('Live mount memory bounds', () => {
  it('fails closed at the store entry budget and recovers when entries expire', async () => {
    // The runtime also bounds per-identity rate-limit buckets (1,000 per
    // 60-second window), so each window of fresh identities advances the clock.
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    const store = new MemoryLiveStore({
      maxEntries: 200,
      ttlMs: 60_000,
      now: () => Date.now(),
    });
    const runtime = await boot(store);
    for (let window = 0; window < 5; window++) {
      await mountRange(runtime, window * 200, (window + 1) * 200);
      expect(store.size).toBe(200);
      // A full store rejects new state instead of evicting live components.
      expect(await rejection(mount(runtime, 10_000 + window))).toEqual({
        status: 503,
        code: 'STORE_CAPACITY',
      });
      expect(store.size).toBe(200);
      vi.setSystemTime(Date.now() + 60_000);
    }
  }, 600_000);

  it('releases every entry on revocation and returns to the same retained heap', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] });
    const store = new MemoryLiveStore({
      maxEntries: 5000,
      now: () => Date.now(),
    });
    const runtime = await boot(store);
    // Warm up module, template and JIT caches before taking the baseline.
    await mountRange(runtime, 0, 200);
    for (let index = 0; index < 200; index++) store.revoke(binding(index));
    expect(store.size).toBe(0);
    const baseline = retainedHeap();
    const samples: number[] = [];
    for (let cycle = 1; cycle <= 4; cycle++) {
      vi.setSystemTime(Date.now() + 60_000);
      await mountRange(runtime, cycle * 1000, cycle * 1000 + 500);
      expect(store.size).toBe(500);
      for (let index = cycle * 1000; index < cycle * 1000 + 500; index++)
        store.revoke(binding(index));
      expect(store.size).toBe(0);
      samples.push(retainedHeap());
    }
    // 2,000 measured mounts: retained growth stays far below what a cycle
    // allocates (500 entries with rendered HTML) and does not trend upwards.
    const last = samples.at(-1) ?? Number.POSITIVE_INFINITY;
    const second = samples[1] ?? Number.NEGATIVE_INFINITY;
    expect((last - baseline) / MiB).toBeLessThan(8);
    expect((last - second) / MiB).toBeLessThan(4);
  }, 600_000);
});
