import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ActionContext,
  ActionGroup,
  ActionInput,
  ActionsModule,
  MemoryIdempotencyStore,
  ServerAction,
} from '../packages/actions/dist/index.js';
import type {
  ActionIdempotencyStore,
  StoredActionOutcome,
} from '../packages/actions/dist/index.js';
import { RedisActionIdempotencyStore } from '../packages/realtime-redis/dist/actions.js';
import { RespConnection } from '../packages/realtime-redis/dist/index.js';
import { respDouble } from './support/resp-double.js';
import type { RespDouble } from './support/resp-double.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const hex = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');
const outcome = (data: number): StoredActionOutcome => ({
  data: { charged: data },
  notifications: [{ level: 'success', message: 'Paid' }],
});

interface Harness {
  /** Make `ms` pass for TTLs and leases. */
  advance(ms: number): Promise<void>;
  /** A store instance; shared harnesses return instances over one server. */
  store(options?: {
    readonly leaseMs?: number;
  }): Promise<ActionIdempotencyStore>;
}
const memory = (): Harness => {
  let now = 1_000_000;
  let instance: MemoryIdempotencyStore | undefined;
  return {
    advance: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    store: () => {
      instance ??= new MemoryIdempotencyStore({ now: () => now });
      return Promise.resolve(instance);
    },
  };
};
const redis = async (): Promise<Harness> => {
  const double = await respDouble();
  cleanup.push(() => double.close());
  return {
    advance: (ms) => sleep(ms),
    store: (options = {}) => {
      const store = new RedisActionIdempotencyStore({
        port: double.port,
        prefix: 'test:idem:',
        ...options,
      });
      cleanup.push(() => store.close());
      return Promise.resolve(store);
    },
  };
};

describe.each([
  ['MemoryIdempotencyStore', memory],
  ['RedisActionIdempotencyStore (RESP double)', redis],
] as const)('ActionIdempotencyStore contract: %s', (_name, create) => {
  it('claims once, reports in-progress, then replays the stored outcome', async () => {
    const harness = await create();
    const store = await harness.store();
    const key = hex('k1');
    const fingerprint = hex('input-1');
    expect(await store.begin(key, fingerprint, 60_000)).toEqual({
      status: 'started',
    });
    expect(await store.begin(key, fingerprint, 60_000)).toEqual({
      status: 'in-progress',
    });
    await store.complete(key, outcome(5));
    expect(await store.begin(key, fingerprint, 60_000)).toEqual({
      status: 'replay',
      outcome: outcome(5),
    });
  });

  it('reports a mismatch for a different input, in progress and after completion', async () => {
    const harness = await create();
    const store = await harness.store();
    const key = hex('k2');
    await store.begin(key, hex('a'), 60_000);
    expect(await store.begin(key, hex('b'), 60_000)).toEqual({
      status: 'mismatch',
    });
    await store.complete(key, outcome(1));
    expect(await store.begin(key, hex('b'), 60_000)).toEqual({
      status: 'mismatch',
    });
  });

  it('releases an abandoned claim so the client may retry', async () => {
    const harness = await create();
    const store = await harness.store();
    const key = hex('k3');
    await store.begin(key, hex('a'), 60_000);
    await store.abandon(key);
    expect(await store.begin(key, hex('a'), 60_000)).toEqual({
      status: 'started',
    });
  });

  it('keeps keys independent and ignores completion of an unclaimed key', async () => {
    const harness = await create();
    const store = await harness.store();
    await store.complete(hex('never-claimed'), outcome(9));
    expect(await store.begin(hex('never-claimed'), hex('a'), 60_000)).toEqual({
      status: 'started',
    });
    expect(await store.begin(hex('other'), hex('a'), 60_000)).toEqual({
      status: 'started',
    });
  });

  it('forgets a completed key after its TTL', async () => {
    const harness = await create();
    const store = await harness.store();
    const key = hex('k4');
    await store.begin(key, hex('a'), 1000);
    await store.complete(key, outcome(2));
    await harness.advance(1200);
    expect(await store.begin(key, hex('a'), 1000)).toEqual({
      status: 'started',
    });
  });

  // Memory harnesses hand out one instance; Redis ones two instances over one server.
  it('shares claims and outcomes between store instances', async () => {
    const harness = await create();
    const a = await harness.store();
    const b = await harness.store();
    const key = hex('k5');
    expect(await a.begin(key, hex('a'), 60_000)).toEqual({
      status: 'started',
    });
    expect(await b.begin(key, hex('a'), 60_000)).toEqual({
      status: 'in-progress',
    });
    await a.complete(key, outcome(3));
    expect(await b.begin(key, hex('a'), 60_000)).toEqual({
      status: 'replay',
      outcome: outcome(3),
    });
  });
});

describe('RedisActionIdempotencyStore', () => {
  async function setup(
    options: { leaseMs?: number; maxOutcomeBytes?: number } = {},
  ) {
    const double = await respDouble();
    cleanup.push(() => double.close());
    const make = (
      extra: {
        leaseMs?: number;
        maxOutcomeBytes?: number;
        randomOwner?: () => string;
      } = {},
    ) => {
      const store = new RedisActionIdempotencyStore({
        port: double.port,
        prefix: 'test:idem:',
        ...options,
        ...extra,
      });
      cleanup.push(() => store.close());
      return store;
    };
    const raw = new RespConnection({ port: double.port });
    cleanup.push(() => raw.close());
    return { double, make, raw };
  }

  it('renews the lease while the handler runs and frees a crashed claim after one lease', async () => {
    const { make } = await setup({ leaseMs: 1000 });
    const a = make();
    const b = make();
    const key = hex('lease');
    expect((await a.begin(key, hex('x'), 60_000)).status).toBe('started');
    // Three lease periods: renewal keeps the claim.
    await sleep(2500);
    expect((await b.begin(key, hex('x'), 60_000)).status).toBe('in-progress');
    // A crash (no renewal, no completion) frees the key after one lease.
    await a.close();
    expect((await b.begin(key, hex('x'), 60_000)).status).toBe('in-progress');
    await sleep(1300);
    expect((await b.begin(key, hex('x'), 60_000)).status).toBe('started');
  });

  it('never commits over a claim that lapsed and was taken over by another replica', async () => {
    const { make, raw } = await setup();
    const a = make();
    const b = make();
    const key = hex('takeover');
    await a.begin(key, hex('x'), 60_000);
    // Simulate a lapsed lease.
    await raw.command('DEL', `test:idem:${key}`);
    expect((await b.begin(key, hex('x'), 60_000)).status).toBe('started');
    await expect(a.complete(key, outcome(1))).rejects.toThrow(
      'Idempotency claim lapsed before the action completed',
    );
    await a.abandon(key);
    // B's claim is untouched by A's completion and abandon.
    expect((await a.begin(key, hex('x'), 60_000)).status).toBe('in-progress');
    await b.complete(key, outcome(2));
    expect(await a.begin(key, hex('x'), 60_000)).toEqual({
      status: 'replay',
      outcome: outcome(2),
    });
  });

  it('fails closed when the outcome cannot be stored: the claim is kept, not released', async () => {
    const { make } = await setup({ maxOutcomeBytes: 1024 });
    const a = make();
    const key = hex('poisoned');
    await a.begin(key, hex('x'), 60_000);
    await expect(a.complete(key, { data: 'x'.repeat(2000) })).rejects.toThrow(
      'Action outcome exceeds the idempotency store limit',
    );
    // The runtime abandons after a failed completion; the store ignores it.
    await a.abandon(key);
    expect((await a.begin(key, hex('x'), 60_000)).status).toBe('in-progress');
    expect(a.activeClaims).toBe(0);
  });

  it('fails closed on Redis errors and corrupt records', async () => {
    const { double, make, raw } = await setup();
    const store = make();
    const key = hex('corrupt');
    await raw.command('SET', `test:idem:${key}`, '{"v":1,"f":42}');
    await expect(store.begin(key, hex('x'), 60_000)).rejects.toThrow(
      'Redis idempotency store: corrupt record',
    );
    await raw.command('SET', `test:idem:${key}`, 'not json');
    await expect(store.begin(key, hex('x'), 60_000)).rejects.toThrow(
      'corrupt record',
    );
    await double.close();
    const failure = await store
      .begin(hex('down'), hex('x'), 60_000)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'Action idempotency store is unavailable',
    );
    expect((failure as Error).message).not.toContain(hex('down'));
  });

  it('stores only the fingerprint and outcome, never identities or the raw key', async () => {
    const { double, make } = await setup();
    const store = make();
    const key = hex(
      'tenant-a\u0000user-alice\u0000cart\u0000pay\u00000\u0000k',
    );
    await store.begin(key, hex('input'), 60_000);
    const pending = double.values.get(`test:idem:${key}`);
    expect(typeof pending).toBe('string');
    expect(Object.keys(JSON.parse(String(pending)) as object).sort()).toEqual([
      'f',
      'o',
      'v',
    ]);
    await store.complete(key, outcome(4));
    const done = JSON.parse(
      String(double.values.get(`test:idem:${key}`)),
    ) as Record<string, unknown>;
    expect(Object.keys(done).sort()).toEqual(['f', 'r', 'v']);
    expect(JSON.stringify(done)).not.toMatch(/alice|tenant-a/);
  });

  it('validates keys, fingerprints, TTLs and options', async () => {
    const { make } = await setup();
    const store = make();
    await expect(store.begin('raw-key', hex('x'), 60_000)).rejects.toThrow(
      'keys must be SHA-256 hex digests',
    );
    await expect(store.begin(hex('a'), 'fp', 60_000)).rejects.toThrow(
      'fingerprints must be SHA-256 hex digests',
    );
    await expect(store.begin(hex('a'), hex('x'), 10)).rejects.toThrow(
      'invalid TTL',
    );
    expect(() => new RedisActionIdempotencyStore({ leaseMs: 10 })).toThrow(
      'invalid lease',
    );
    expect(
      () => new RedisActionIdempotencyStore({ prefix: 'Bad Prefix' }),
    ).toThrow('invalid prefix');
    expect(
      () => new RedisActionIdempotencyStore({ maxOutcomeBytes: 10 }),
    ).toThrow('invalid outcome limit');
    const weak = make({ randomOwner: () => 'short' });
    await expect(weak.begin(hex('a'), hex('x'), 60_000)).rejects.toThrow(
      'invalid claim owner',
    );
  });
});

// The runtime end to end: identity-scoped keys, replay and fail-closed HTTP.
const origin = 'http://localhost:4280';
const users: Record<
  string,
  { subject: string; tenant: string; csrfToken: string }
> = {
  alice: {
    subject: 'user-alice',
    tenant: 'acme',
    csrfToken: 'alice-csrf-token-0123456789abcdef',
  },
  bob: {
    subject: 'user-bob',
    tenant: 'globex',
    csrfToken: 'bob-csrf-token-0123456789abcdef00',
  },
};
function post(
  url: string,
  user: string,
  key: string,
  input: unknown,
): Promise<{
  status: number;
  replayed: boolean;
  body: Record<string, unknown>;
}> {
  const csrf = users[user]?.csrfToken ?? '';
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          'x-session': user,
          'x-nestvexa-csrf': csrf,
          'idempotency-key': key,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            replayed: response.headers['idempotent-replayed'] === 'true',
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
              string,
              unknown
            >,
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(JSON.stringify({ input }));
  });
}

describe('server actions with RedisActionIdempotencyStore', () => {
  async function app(store: ActionIdempotencyStore) {
    const charges: string[] = [];
    @ActionGroup('cart')
    class Cart {
      @ServerAction({ id: 'pay', idempotent: true })
      pay(
        @ActionInput() input: { amount: number },
        @ActionContext() context: ActionContext,
      ) {
        charges.push(context.identity.subject);
        return { charged: input.amount, charge: charges.length };
      }
    }
    const module = await Test.createTestingModule({
      imports: [
        ActionsModule.register({
          groups: [Cart],
          origin,
          idempotency: { store },
          resolveIdentity: (request: object) => {
            const headers = Reflect.get(request, 'headers') as Record<
              string,
              string | undefined
            >;
            return users[headers['x-session'] ?? ''] ?? null;
          },
          authorize: () => true,
        }),
      ],
    }).compile();
    const nest: INestApplication = module.createNestApplication({
      logger: false,
    });
    cleanup.push(() => nest.close());
    await nest.listen(0, '127.0.0.1');
    return {
      url: `${await nest.getUrl()}/_nestvexa/actions/cart/pay`,
      charges,
    };
  }

  it('replays per identity: the same key from another user runs separately', async () => {
    const double = await respDouble();
    cleanup.push(() => double.close());
    const store = new RedisActionIdempotencyStore({ port: double.port });
    cleanup.push(() => store.close());
    const { url, charges } = await app(store);
    const key = 'payment-key-redis-000000001';
    const first = await post(url, 'alice', key, { amount: 5 });
    expect(first.status).toBe(200);
    expect(first.replayed).toBe(false);
    const replay = await post(url, 'alice', key, { amount: 5 });
    expect(replay.status).toBe(200);
    expect(replay.replayed).toBe(true);
    expect(replay.body['data']).toEqual({ charged: 5, charge: 1 });
    const other = await post(url, 'bob', key, { amount: 5 });
    expect(other.replayed).toBe(false);
    expect(charges).toEqual(['user-alice', 'user-bob']);
    const mismatch = await post(url, 'alice', key, { amount: 6 });
    expect(mismatch.status).toBe(409);
    expect(charges).toHaveLength(2);
  }, 60_000);

  it('fails closed over HTTP when Redis is down: 500 and the handler never runs', async () => {
    const double = await respDouble();
    const store = new RedisActionIdempotencyStore({
      port: double.port,
      circuitBreaker: false,
      commandTimeoutMs: 500,
    });
    cleanup.push(() => store.close());
    await double.close();
    const { url, charges } = await app(store);
    const reply = await post(url, 'alice', 'payment-key-redis-000000002', {
      amount: 1,
    });
    expect(reply.status).toBe(500);
    expect(JSON.stringify(reply.body)).not.toContain('payment-key');
    expect(charges).toEqual([]);
  }, 60_000);
});
