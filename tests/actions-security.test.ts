import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, timingSafeEqual } from 'node:crypto';
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
  ActionIdentity,
  ActionsModuleOptions,
} from '../packages/actions/dist/index.js';

// Negative tests for ACT-016: expired/tampered tokens, expired idempotency
// records, non-boolean authorization and groups registered without guards.
const origin = 'http://localhost:4310';
const secret = Buffer.from('test-signing-key-0123456789abcdef0123456789');
const apps: INestApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** Minimal signed bearer token `<payload>.<mac>` with an expiry, for the host resolver. */
function token(subject: string, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ subject, expiresAt })).toString(
    'base64url',
  );
  const mac = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}
function verify(value: string | undefined, now: number): ActionIdentity | null {
  const [payload, mac] = (value ?? '').split('.');
  if (!payload || !mac) return null;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(mac, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return null;
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
    subject: string;
    expiresAt: number;
  };
  return claims.expiresAt > now ? { subject: claims.subject } : null;
}

function send(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: { data?: unknown; error?: { code: string; reason?: string } };
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: 'POST', headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: text ? JSON.parse(text) : {},
          });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

async function start(options: Omit<ActionsModuleOptions, 'origin'>) {
  const module = await Test.createTestingModule({
    imports: [ActionsModule.register({ origin, ...options })],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  apps.push(app);
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/_nestvexa/actions`;
  return (path: string, input: unknown, headers: Record<string, string> = {}) =>
    send(
      `${base}/${path}`,
      { origin, 'content-type': 'application/json', ...headers },
      JSON.stringify({ input }),
    );
}

describe('server action negative security cases', () => {
  it('rejects expired and tampered bearer tokens before any guard or handler runs', async () => {
    const clock = { now: 1_000_000 };
    let executed = 0;
    @ActionGroup('payments')
    class Payments {
      @ServerAction({ id: 'charge' })
      charge(
        @ActionInput() input: { cents: number },
        @ActionContext() context: ActionContext,
      ) {
        executed++;
        return { by: context.identity.subject, cents: input.cents };
      }
    }
    const call = await start({
      groups: [Payments],
      csrf: { required: false },
      resolveIdentity: (request) =>
        verify(
          (Reflect.get(request, 'headers') as Record<string, string>)[
            'authorization'
          ]?.replace(/^Bearer /, ''),
          clock.now,
        ),
      authorize: (identity) => identity.subject === 'alice',
    });
    const valid = token('alice', clock.now + 60_000);
    const ok = await call(
      'payments/charge',
      { cents: 5 },
      {
        authorization: `Bearer ${valid}`,
      },
    );
    expect(ok.body.data).toEqual({ by: 'alice', cents: 5 });

    clock.now += 120_000;
    const expired = await call(
      'payments/charge',
      { cents: 5 },
      {
        authorization: `Bearer ${valid}`,
      },
    );
    expect(expired.status).toBe(401);
    expect(expired.body.error).toMatchObject({
      code: 'UNAUTHENTICATED',
      reason: 'IDENTITY_REQUIRED',
    });

    // Forged claims: swap the subject but keep the old signature.
    const [, mac] = token('alice', clock.now + 60_000).split('.');
    const forged = `${Buffer.from(
      JSON.stringify({ subject: 'admin', expiresAt: clock.now + 60_000 }),
    ).toString('base64url')}.${mac ?? ''}`;
    const tampered = await call(
      'payments/charge',
      { cents: 5 },
      {
        authorization: `Bearer ${forged}`,
      },
    );
    expect(tampered.status).toBe(401);
    // A correctly signed token for a principal the policy rejects.
    const mallory = await call(
      'payments/charge',
      { cents: 5 },
      {
        authorization: `Bearer ${token('mallory', clock.now + 60_000)}`,
      },
    );
    expect(mallory.body.error).toMatchObject({
      code: 'FORBIDDEN',
      reason: 'POLICY',
    });
    expect(executed).toBe(1);
  });

  it('re-executes after an idempotency record expires and never replays across inputs', async () => {
    const clock = { now: 5_000_000 };
    const store = new MemoryIdempotencyStore({ now: () => clock.now });
    let orders = 0;
    @ActionGroup('orders')
    class Orders {
      @ServerAction({ id: 'place', idempotent: true })
      place(@ActionInput() input: { sku: string }) {
        orders++;
        return { order: orders, sku: input.sku };
      }
    }
    const call = await start({
      groups: [Orders],
      csrf: { required: false },
      idempotency: { store, ttlMs: 1_000 },
      resolveIdentity: () => ({ subject: 'alice' }),
      authorize: () => true,
    });
    const key = { 'idempotency-key': 'order-key-0123456789abcdef' };
    const first = await call('orders/place', { sku: 'a' }, key);
    const replay = await call('orders/place', { sku: 'a' }, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data).toEqual(first.body.data);
    const swapped = await call('orders/place', { sku: 'b' }, key);
    expect(swapped.body.error).toMatchObject({
      code: 'CONFLICT',
      reason: 'IDEMPOTENCY_MISMATCH',
    });
    expect(orders).toBe(1);

    // After the retention window the key is no longer a replay guard.
    clock.now += 1_001;
    const after = await call('orders/place', { sku: 'a' }, key);
    expect(after.headers['idempotent-replayed']).toBeUndefined();
    expect(after.body.data).toEqual({ order: 2, sku: 'a' });
    // Malformed and missing keys are rejected without executing.
    expect(
      (await call('orders/place', { sku: 'a' }, { 'idempotency-key': 'short' }))
        .body.error?.reason,
    ).toBe('IDEMPOTENCY_KEY');
    expect((await call('orders/place', { sku: 'a' })).body.error?.reason).toBe(
      'IDEMPOTENCY_KEY',
    );
    expect(orders).toBe(2);
  });

  it('admits only a literal true from authorize and fails closed when it throws', async () => {
    let executed = 0;
    let decision: unknown = true;
    @ActionGroup('admin')
    class Admin {
      @ServerAction({ id: 'wipe' })
      wipe() {
        executed++;
        return 'wiped';
      }
    }
    const call = await start({
      groups: [Admin],
      csrf: { required: false },
      resolveIdentity: () => ({ subject: 'alice' }),
      authorize: () => {
        if (decision === 'throw') throw new Error('policy store offline');
        return decision as boolean;
      },
    });
    expect((await call('admin/wipe', null)).body.data).toBe('wiped');
    for (const value of [1, 'yes', {}, [], undefined, null, false]) {
      decision = value;
      const denied = await call('admin/wipe', null);
      expect(denied.status).toBe(403);
      expect(denied.body.error?.reason).toBe('POLICY');
    }
    decision = 'throw';
    const failed = await call('admin/wipe', null);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain('policy store offline');
    expect(executed).toBe(1);
  });

  it('protects groups registered without any Nest guard through host policy only', async () => {
    let executed = 0;
    // No @UseGuards on purpose: the host policy is the only authorization.
    @ActionGroup('unguarded')
    class Unguarded {
      @ServerAction({ id: 'delete-account' })
      deleteAccount(@ActionContext() context: ActionContext) {
        executed++;
        return context.identity.subject;
      }
    }
    // Registering without an authorization policy is impossible.
    expect(() =>
      ActionsModule.register({
        groups: [Unguarded],
        origin,
        resolveIdentity: () => ({ subject: 'alice' }),
      } as unknown as ActionsModuleOptions),
    ).toThrow(/authorization-first/);
    // An allowlist policy that does not list this action denies it.
    const allowed = new Set(['profile/read']);
    const call = await start({
      groups: [Unguarded],
      csrf: { required: false },
      resolveIdentity: () => ({ subject: 'alice' }),
      authorize: (_identity, action) =>
        allowed.has(`${action.group}/${action.action}`),
    });
    const denied = await call('unguarded/delete-account', null);
    expect(denied.status).toBe(403);
    expect(denied.body.error?.reason).toBe('POLICY');
    // Anonymous callers never reach policy or handler.
    const anonymous = await start({
      groups: [Unguarded],
      csrf: { required: false },
      resolveIdentity: () => null,
      authorize: () => true,
    });
    expect((await anonymous('unguarded/delete-account', null)).status).toBe(
      401,
    );
    // Unknown action ids are plain 404s, never routed to another method.
    expect((await call('unguarded/delete-everything', null)).status).toBe(404);
    expect(executed).toBe(0);
  });
});
