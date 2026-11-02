import 'reflect-metadata';
import {
  BadRequestException,
  Catch,
  ForbiddenException,
  Inject,
  Injectable,
  Module,
  Scope,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type {
  ArgumentMetadata,
  ArgumentsHost,
  CallHandler,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  INestApplication,
  NestInterceptor,
  PipeTransform,
} from '@nestjs/common';
import {
  APP_FILTER,
  APP_GUARD,
  APP_PIPE,
  HttpAdapterHost,
  REQUEST,
} from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { tap } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ActionContext,
  ActionError,
  ActionGroup,
  ActionInput,
  ActionSignal,
  ActionsModule,
  ServerAction,
  createFixedWindowRateLimit,
  redirectTo,
  withNotifications,
} from '../packages/actions/dist/index.js';
import type {
  ActionErrorEvent,
  ActionsHostOptions,
  ActionsModuleOptions,
} from '../packages/actions/dist/index.js';

const origin = 'http://localhost:4100';
const sessions: Record<
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
const apps: INestApplication[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

interface HttpReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json: () => Envelope;
}
interface Envelope {
  protocol?: string;
  ok?: boolean;
  requestId?: string;
  data?: unknown;
  redirect?: { location: string };
  notifications?: { level: string; message: string }[];
  error?: {
    code: string;
    message: string;
    reason?: string;
    detail?: string;
    issues?: { path: (string | number)[]; message: string }[];
  };
  code?: string;
  statusCode?: number;
}

function send(
  url: string,
  options: { method?: string; headers: Record<string, string>; body?: string },
): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: options.method ?? 'POST', headers: options.headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            json: () => JSON.parse(text) as Envelope,
          });
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(8000, () =>
      request.destroy(new Error('Action HTTP fixture deadline')),
    );
    request.end(options.body);
  });
}

function gate() {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
}

interface AddItemInput {
  productId: string;
  quantity: number;
}
class Leak {
  constructor(readonly secret: string) {}
}
class CustomFailure extends Error {}

async function fixture(
  platform: 'express' | 'fastify',
  overrides: Partial<ActionsModuleOptions> = {},
  extraProviders: {
    provide: symbol | string;
    useClass: new (...args: never[]) => object;
  }[] = [],
) {
  const trace: { step: string; id: string }[] = [];
  const intercepted: unknown[] = [];
  const settings = {
    denyPolicy: false,
    hold: false,
    failPayment: false,
    slowAborted: false,
    serialActive: 0,
    serialPeak: 0,
  };
  const errors: ActionErrorEvent[] = [];
  let entered = gate();
  let release = gate();
  const charges: { subject: string; amount: number }[] = [];
  const orders = new Map<string, { tenant: string; total: number }>([
    ['order-acme-1', { tenant: 'acme', total: 10 }],
    ['order-globex-1', { tenant: 'globex', total: 99 }],
  ]);

  @Injectable({ scope: Scope.REQUEST })
  class RequestInfo {
    readonly id = randomUUID();
    constructor(
      @Inject(REQUEST)
      readonly request: { headers: Record<string, string | undefined> },
    ) {}
    log(step: string): void {
      trace.push({ step, id: this.id });
    }
  }
  @Injectable()
  class GlobalGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const request = context
        .switchToHttp()
        .getRequest<{ headers: Record<string, string | undefined> }>();
      trace.push({ step: 'global', id: '' });
      if (request.headers['x-deny-global']) throw new ForbiddenException();
      return true;
    }
  }
  @Injectable()
  class ClassGuard implements CanActivate {
    constructor(@Inject(RequestInfo) private readonly info: RequestInfo) {}
    canActivate(): boolean {
      this.info.log('class');
      if (this.info.request.headers['x-deny-class'])
        throw new ForbiddenException();
      return true;
    }
  }
  @Injectable()
  class MethodGuard implements CanActivate {
    constructor(@Inject(RequestInfo) private readonly info: RequestInfo) {}
    canActivate(): boolean {
      this.info.log('method');
      return !this.info.request.headers['x-deny-method'];
    }
  }
  @Injectable()
  class GlobalPipe implements PipeTransform {
    transform(value: unknown, metadata: ArgumentMetadata): unknown {
      if (metadata.type === 'body') trace.push({ step: 'global-pipe', id: '' });
      return value;
    }
  }
  @Injectable()
  class AddItemPipe implements PipeTransform {
    constructor(@Inject(RequestInfo) private readonly info: RequestInfo) {}
    transform(value: unknown): AddItemInput {
      this.info.log('pipe');
      const problems: string[] = [];
      const record =
        typeof value === 'object' && value !== null
          ? (value as Record<string, unknown>)
          : {};
      if (typeof record['productId'] !== 'string' || !record['productId'])
        problems.push('productId must be a non-empty string');
      const quantity = record['quantity'];
      if (
        typeof quantity !== 'number' ||
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 10
      )
        problems.push('quantity must be an integer between 1 and 10');
      if (problems.length > 0) throw new BadRequestException(problems);
      // Allowlist copy: mass-assigned fields (price, userId, tenant) are dropped.
      return {
        productId: String(record['productId']),
        quantity: Number(quantity),
      };
    }
  }
  @Injectable()
  class TraceInterceptor implements NestInterceptor {
    constructor(@Inject(RequestInfo) private readonly info: RequestInfo) {}
    intercept(_context: ExecutionContext, next: CallHandler<unknown>) {
      this.info.log('interceptor:before');
      return next.handle().pipe(
        tap((value) => {
          intercepted.push(value);
          this.info.log('interceptor:after');
        }),
      );
    }
  }
  @Catch(CustomFailure)
  class MethodFilter implements ExceptionFilter {
    constructor(
      @Inject(HttpAdapterHost) private readonly adapter: HttpAdapterHost,
    ) {}
    catch(_error: CustomFailure, host: ArgumentsHost): void {
      this.adapter.httpAdapter.reply(
        host.switchToHttp().getResponse<unknown>(),
        { code: 'FILTERED' },
        418,
      );
    }
  }
  @Module({
    providers: [
      RequestInfo,
      ClassGuard,
      MethodGuard,
      AddItemPipe,
      TraceInterceptor,
      MethodFilter,
    ],
    exports: [
      RequestInfo,
      ClassGuard,
      MethodGuard,
      AddItemPipe,
      TraceInterceptor,
      MethodFilter,
    ],
  })
  class Services {}

  const checkoutSchema = z.object({
    email: z.email(),
    items: z.array(z.string().min(1)).min(1).max(5),
  });
  const checkoutOutput = z.object({ accepted: z.literal(true) });

  @ActionGroup('cart')
  @UseGuards(ClassGuard)
  class CartActions {
    constructor(@Inject(RequestInfo) private readonly info: RequestInfo) {}

    @ServerAction({ id: 'add-item' })
    @UseGuards(MethodGuard)
    @UseInterceptors(TraceInterceptor)
    add(
      @ActionInput(AddItemPipe) input: AddItemInput,
      @ActionContext() context: ActionContext,
    ) {
      this.info.log('action');
      return {
        owner: context.identity.subject,
        tenant: context.identity.tenant ?? null,
        line: input,
        scope: this.info.id,
        requestId: context.requestId,
        at: new Date(0),
      };
    }

    @ServerAction({ id: 'order' })
    order(
      @ActionInput() input: { orderId: string; tenant?: string },
      @ActionContext() context: ActionContext,
    ) {
      // Tenant comes from the host identity; the client-supplied tenant is ignored.
      const order = orders.get(String(input.orderId));
      if (!order || order.tenant !== context.identity.tenant)
        throw ActionError.notFound('Order not found');
      return { orderId: input.orderId, total: order.total };
    }

    @ServerAction({ id: 'pay', idempotent: true, concurrency: 'serial' })
    async pay(
      @ActionInput() input: { amount: number },
      @ActionContext() context: ActionContext,
    ) {
      if (settings.hold) {
        entered.open();
        await release.promise;
      }
      if (settings.failPayment)
        throw new ActionError('CONFLICT', 'Card declined');
      charges.push({ subject: context.identity.subject, amount: input.amount });
      return { charged: input.amount, charge: charges.length };
    }

    @ServerAction({ id: 'slow', timeoutMs: 60 })
    async slow(@ActionSignal() signal: AbortSignal) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      settings.slowAborted = signal.aborted;
      return { done: true };
    }

    @ServerAction({ id: 'serial', concurrency: 'serial' })
    async serial() {
      settings.serialActive++;
      settings.serialPeak = Math.max(
        settings.serialPeak,
        settings.serialActive,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      settings.serialActive--;
      return null;
    }

    @ServerAction({ id: 'leak' })
    leak(@ActionInput() input: { kind: string }): unknown {
      const cycle: Record<string, unknown> = {};
      cycle['self'] = cycle;
      switch (input.kind) {
        case 'map':
          return new Map([['a', 1]]);
        case 'function':
          return { run: () => 'x' };
        case 'cycle':
          return cycle;
        case 'class':
          return { entity: new Leak('internal-entity-secret') };
        case 'bigint':
          return { value: BigInt(1) };
        case 'nan':
          return { value: Number.NaN };
        default:
          return { when: new Date(86_400_000), nested: [1, 'two', null] };
      }
    }

    @ServerAction({ id: 'crash' })
    crash(): never {
      throw new Error('database password=hunter2 at 10.0.0.5');
    }

    @ServerAction({ id: 'filtered' })
    @UseFilters(MethodFilter)
    filtered(): never {
      throw new CustomFailure('handled by the method filter');
    }

    @ServerAction({
      id: 'checkout',
      input: checkoutSchema,
      output: checkoutOutput,
    })
    checkout(@ActionInput() input: z.infer<typeof checkoutSchema>) {
      if (input.items.includes('broken-output')) return { accepted: 'yes' };
      return { accepted: true as const, echo: Object.keys(input).sort() };
    }

    @ServerAction({ id: 'checkout', version: 2 })
    checkoutV2() {
      return withNotifications(
        { orderId: 42 },
        { level: 'success', message: 'Order placed' },
      );
    }

    @ServerAction({ id: 'go' })
    go() {
      return redirectTo('/orders/42');
    }

    @ServerAction({ id: 'whoami' })
    whoami(@ActionContext() context: ActionContext) {
      return context.identity;
    }

    // Public method without @ServerAction: never exposed.
    notExposed() {
      return 'secret';
    }
  }

  const options: ActionsModuleOptions = {
    groups: [CartActions],
    imports: [Services],
    origin,
    resolveIdentity: (request: object) => {
      const headers = Reflect.get(request, 'headers') as Record<
        string,
        string | undefined
      >;
      const session = sessions[headers['x-session'] ?? ''];
      return session ?? null;
    },
    authorize: () => !settings.denyPolicy,
    onError: (event) => errors.push(event),
    ...overrides,
  };
  const module = await Test.createTestingModule({
    imports: [ActionsModule.register(options)],
    providers: [
      { provide: APP_GUARD, useClass: GlobalGuard },
      { provide: APP_PIPE, useClass: GlobalPipe },
      ...extraProviders,
    ],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  apps.push(app);
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}/api/_nestvexa/actions`;

  async function call(
    path: string,
    input?: unknown,
    options: {
      user?: string | null;
      headers?: Record<string, string>;
      omit?: string[];
      raw?: string;
      method?: string;
    } = {},
  ): Promise<HttpReply> {
    const user = options.user === undefined ? 'alice' : options.user;
    const body =
      options.raw ?? JSON.stringify(input === undefined ? {} : { input });
    const headers: Record<string, string> = {
      origin,
      'content-type': 'application/json',
      ...(user === null
        ? {}
        : {
            'x-session': user,
            'x-nestvexa-csrf':
              sessions[user]?.csrfToken ?? 'unknown-token-xxxxxxxx',
          }),
      ...options.headers,
    };
    for (const name of options.omit ?? []) delete headers[name];
    return send(`${base}/${path}`, {
      headers,
      body,
      ...(options.method ? { method: options.method } : {}),
    });
  }
  return {
    app,
    call,
    trace,
    intercepted,
    settings,
    charges,
    errors,
    gates: () => {
      entered = gate();
      release = gate();
      return { entered, release };
    },
  };
}

describe.each(['express', 'fastify'] as const)(
  'server actions over %s',
  (platform) => {
    it('runs global/class/method guards, pipes and interceptors through the real Nest pipeline', async () => {
      const f = await fixture(platform);
      const response = await f.call('cart/add-item', {
        productId: 'sku-1',
        quantity: 2,
      });
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.json();
      expect(body).toMatchObject({
        protocol: 'nestvexa-actions/1',
        ok: true,
        data: {
          owner: 'user-alice',
          tenant: 'acme',
          line: { productId: 'sku-1', quantity: 2 },
          at: '1970-01-01T00:00:00.000Z',
        },
      });
      expect(response.headers['x-nestvexa-request-id']).toBe(body.requestId);
      expect((body.data as { requestId: string }).requestId).toBe(
        body.requestId,
      );
      expect(f.trace.map(({ step }) => step)).toEqual([
        'global',
        'class',
        'method',
        'interceptor:before',
        'global-pipe',
        'pipe',
        'action',
        'interceptor:after',
      ]);
      // One request-scoped provider instance is shared by guards, pipe, interceptor and the group.
      const scoped = new Set(
        f.trace.filter(({ id }) => id).map(({ id }) => id),
      );
      expect(scoped).toEqual(new Set([(body.data as { scope: string }).scope]));
      // Application interceptors observe the raw action result, not the envelope.
      expect(f.intercepted[0]).toMatchObject({ owner: 'user-alice' });
      expect(f.intercepted[0]).not.toHaveProperty('protocol');
      const second = (
        await f.call('cart/add-item', { productId: 'sku-2', quantity: 1 })
      ).json();
      expect((second.data as { scope: string }).scope).not.toBe(
        (body.data as { scope: string }).scope,
      );
    });

    it('ignores forged identity claims and mass-assigned fields in the body', async () => {
      const f = await fixture(platform);
      const body = (
        await f.call('cart/add-item', {
          productId: 'sku-1',
          quantity: 1,
          userId: 'admin',
          tenant: 'globex',
          price: 0,
        })
      ).json();
      expect(body.data).toMatchObject({
        owner: 'user-alice',
        tenant: 'acme',
        line: { productId: 'sku-1', quantity: 1 },
      });
      expect((body.data as { line: object }).line).not.toHaveProperty('price');
      const forged = await f.call('cart/whoami', undefined, {
        headers: { 'x-user': 'admin', 'x-tenant': 'globex' },
      });
      expect(forged.json().data).toEqual({
        subject: 'user-alice',
        tenant: 'acme',
        csrfToken: sessions['alice']?.csrfToken,
      });
    });

    it('exposes only explicitly registered POST actions', async () => {
      const f = await fixture(platform);
      for (const path of [
        'cart/not-exposed',
        'cart/notExposed',
        'cart/unknown',
        'billing/add-item',
        'cart/add-item/v9',
        'cart/constructor',
        'cart/__proto__',
      ])
        expect((await f.call(path, {})).status).toBe(404);
      const get = await f.call('cart/whoami', undefined, {
        method: 'GET',
        raw: '',
      });
      expect(get.status).toBe(404);
      expect(f.trace.some(({ step }) => step === 'action')).toBe(false);
    });

    it('rejects missing, forged and cross-session CSRF tokens before guards run', async () => {
      const f = await fixture(platform);
      const cases: Parameters<typeof f.call>[2][] = [
        { omit: ['x-nestvexa-csrf'] },
        { headers: { 'x-nestvexa-csrf': 'forged-token-0123456789abcdef' } },
        { headers: { 'x-nestvexa-csrf': sessions['bob']?.csrfToken ?? '' } },
        { headers: { 'x-nestvexa-csrf': '' } },
      ];
      for (const options of cases) {
        const response = await f.call(
          'cart/add-item',
          { productId: 'sku', quantity: 1 },
          options,
        );
        expect(response.status).toBe(403);
        expect(response.json().error).toMatchObject({
          code: 'FORBIDDEN',
          reason: 'CSRF',
        });
      }
      expect(f.trace.map(({ step }) => step)).toEqual([
        'global',
        'global',
        'global',
        'global',
      ]);
    });

    it('rejects wrong or missing origins and non-JSON content types', async () => {
      const f = await fixture(platform);
      for (const options of [
        { headers: { origin: 'http://evil.example' } },
        { headers: { origin: `${origin}/` } },
        { headers: { origin: 'null' } },
        { omit: ['origin'] },
      ]) {
        const response = await f.call('cart/whoami', undefined, options);
        expect(response.status).toBe(403);
        expect(response.json().error?.reason).toBe('ORIGIN');
      }
      const text = await f.call('cart/whoami', undefined, {
        headers: { 'content-type': 'text/plain' },
      });
      expect(text.status).toBe(415);
      expect(text.json().error).toMatchObject({
        code: 'VALIDATION',
        reason: 'CONTENT_TYPE',
      });
    });

    it('rejects unauthenticated callers and host policy denials', async () => {
      const f = await fixture(platform);
      const anonymous = await f.call('cart/whoami', undefined, { user: null });
      expect(anonymous.status).toBe(401);
      expect(anonymous.json().error?.code).toBe('UNAUTHENTICATED');
      f.settings.denyPolicy = true;
      const denied = await f.call('cart/whoami');
      expect(denied.status).toBe(403);
      expect(denied.json().error).toMatchObject({
        code: 'FORBIDDEN',
        reason: 'POLICY',
      });
    });

    it('denies at the global, class and method guard levels without executing the action', async () => {
      const f = await fixture(platform);
      for (const header of ['x-deny-global', 'x-deny-class', 'x-deny-method']) {
        const response = await f.call(
          'cart/add-item',
          { productId: 'sku', quantity: 1 },
          { headers: { [header]: '1' } },
        );
        expect(response.status).toBe(403);
        expect(response.json()).toMatchObject({
          ok: false,
          error: { code: 'FORBIDDEN' },
        });
      }
      expect(
        f.trace.some(({ step }) => step === 'action' || step === 'pipe'),
      ).toBe(false);
    });

    it('bounds payload size, depth and keys and rejects prototype pollution', async () => {
      const f = await fixture(platform);
      const large = await f.call('cart/leak', { kind: 'x'.repeat(70_000) });
      expect(large.status).toBe(413);
      expect(large.json().error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
      let deep: unknown = 'leaf';
      for (let index = 0; index < 40; index++) deep = [deep];
      const nested = await f.call('cart/leak', { kind: 'safe', deep });
      expect(nested.status).toBe(413);
      expect(nested.json().error?.reason).toBe('JSON_DEPTH');
      const wide = await f.call('cart/leak', {
        kind: 'safe',
        list: Array.from({ length: 10_001 }, () => 0),
      });
      expect(wide.status).toBe(413);
      for (const raw of [
        '{"input":{"kind":"safe","__proto__":{"polluted":true}}}',
        '{"input":{"kind":"safe","constructor":{"prototype":{"polluted":true}}}}',
        '{"__proto__":{"polluted":true}}',
      ]) {
        const response = await f.call('cart/leak', undefined, { raw });
        expect(response.status).toBe(400);
        // Fastify's secure JSON parser rejects these before routing; Express reaches admission.
        if (platform === 'express')
          expect(response.json().error).toMatchObject({
            code: 'VALIDATION',
            reason: 'FORBIDDEN_KEY',
          });
      }
      expect(Reflect.get(Object.prototype, 'polluted')).toBeUndefined();
      const extra = await f.call('cart/whoami', undefined, {
        raw: JSON.stringify({ userId: 'admin' }),
      });
      expect(extra.status).toBe(400);
      expect(extra.json().error?.reason).toBe('UNKNOWN_FIELD');
      const unexpected = await f.call('cart/whoami', { surprise: true });
      expect(unexpected.status).toBe(400);
      expect(unexpected.json().error?.reason).toBe('UNEXPECTED_INPUT');
      const array = await f.call('cart/whoami', undefined, { raw: '[]' });
      expect(array.status).toBe(400);
    });

    it('maps malformed DTOs to VALIDATION issues from Nest pipes', async () => {
      const f = await fixture(platform);
      const response = await f.call('cart/add-item', {
        productId: '',
        quantity: 99,
      });
      expect(response.status).toBe(400);
      expect(response.json().error).toEqual({
        code: 'VALIDATION',
        message: 'The action input is invalid.',
        issues: [
          { path: [], message: 'productId must be a non-empty string' },
          { path: [], message: 'quantity must be an integer between 1 and 10' },
        ],
      });
      expect(f.trace.some(({ step }) => step === 'action')).toBe(false);
    });

    it('isolates tenants even when the client names another tenant', async () => {
      const f = await fixture(platform);
      const swapped = await f.call('cart/order', {
        orderId: 'order-globex-1',
        tenant: 'globex',
      });
      expect(swapped.status).toBe(404);
      expect(swapped.json().error).toMatchObject({
        code: 'NOT_FOUND',
        message: 'Order not found',
      });
      const owner = await f.call(
        'cart/order',
        { orderId: 'order-globex-1' },
        { user: 'bob' },
      );
      expect(owner.json().data).toEqual({
        orderId: 'order-globex-1',
        total: 99,
      });
    });

    it('replays idempotent results, rejects mismatches and concurrent duplicates', async () => {
      const f = await fixture(platform);
      const missing = await f.call('cart/pay', { amount: 5 });
      expect(missing.status).toBe(400);
      expect(missing.json().error?.reason).toBe('IDEMPOTENCY_KEY');
      const short = await f.call(
        'cart/pay',
        { amount: 5 },
        { headers: { 'idempotency-key': 'short' } },
      );
      expect(short.json().error?.reason).toBe('IDEMPOTENCY_KEY');
      const key = { 'idempotency-key': 'payment-key-000000000001' };
      const first = await f.call('cart/pay', { amount: 5 }, { headers: key });
      expect(first.status).toBe(200);
      expect(first.json().data).toEqual({ charged: 5, charge: 1 });
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      const replay = await f.call('cart/pay', { amount: 5 }, { headers: key });
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.json().data).toEqual({ charged: 5, charge: 1 });
      expect(replay.json().requestId).not.toBe(first.json().requestId);
      const mismatch = await f.call(
        'cart/pay',
        { amount: 500 },
        { headers: key },
      );
      expect(mismatch.status).toBe(409);
      expect(mismatch.json().error).toMatchObject({
        code: 'CONFLICT',
        reason: 'IDEMPOTENCY_MISMATCH',
      });
      // Keys are scoped by identity: another user's identical key is independent.
      const otherUser = await f.call(
        'cart/pay',
        { amount: 5 },
        { headers: key, user: 'bob' },
      );
      expect(otherUser.headers['idempotent-replayed']).toBeUndefined();
      expect(f.charges).toEqual([
        { subject: 'user-alice', amount: 5 },
        { subject: 'user-bob', amount: 5 },
      ]);
      const unsupported = await f.call('cart/whoami', undefined, {
        headers: key,
      });
      expect(unsupported.json().error?.reason).toBe('IDEMPOTENCY_UNSUPPORTED');
    });

    it('returns 409 for a concurrent duplicate payment and allows retry after failure', async () => {
      const f = await fixture(platform);
      const { entered, release } = f.gates();
      f.settings.hold = true;
      const key = { 'idempotency-key': 'payment-key-000000000002' };
      const pending = f.call('cart/pay', { amount: 7 }, { headers: key });
      await entered.promise;
      try {
        const duplicate = await f.call(
          'cart/pay',
          { amount: 7 },
          { headers: key },
        );
        expect(duplicate.status).toBe(409);
        expect(duplicate.json().error?.reason).toBe('IDEMPOTENCY_IN_PROGRESS');
      } finally {
        release.open();
      }
      expect((await pending).status).toBe(200);
      expect(f.charges).toHaveLength(1);
      f.settings.hold = false;
      f.settings.failPayment = true;
      const retryKey = { 'idempotency-key': 'payment-key-000000000003' };
      const failed = await f.call(
        'cart/pay',
        { amount: 1 },
        { headers: retryKey },
      );
      expect(failed.status).toBe(409);
      expect(failed.json().error).toMatchObject({
        code: 'CONFLICT',
        message: 'Card declined',
      });
      f.settings.failPayment = false;
      const retried = await f.call(
        'cart/pay',
        { amount: 1 },
        { headers: retryKey },
      );
      expect(retried.status).toBe(200);
      expect(retried.headers['idempotent-replayed']).toBeUndefined();
      expect(f.charges).toHaveLength(2);
    });

    it('serializes serial actions per identity and group', async () => {
      const f = await fixture(platform);
      const responses = await Promise.all(
        Array.from({ length: 4 }, () => f.call('cart/serial')),
      );
      expect(responses.map((response) => response.status)).toEqual([
        200, 200, 200, 200,
      ]);
      expect(f.settings.serialPeak).toBe(1);
      expect(responses[0]?.json().data).toBeNull();
    });

    it('times out with TIMEOUT and aborts the action signal', async () => {
      const f = await fixture(platform);
      const response = await f.call('cart/slow');
      expect(response.status).toBe(504);
      expect(response.json().error).toMatchObject({
        code: 'TIMEOUT',
        reason: 'DEADLINE',
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(f.settings.slowAborted).toBe(true);
    });

    it.each(['map', 'function', 'cycle', 'class', 'bigint', 'nan'])(
      'rejects non-JSON-safe output (%s) without leaking it',
      async (kind) => {
        const f = await fixture(platform);
        const response = await f.call('cart/leak', { kind });
        expect(response.status).toBe(500);
        expect(response.json().error).toEqual({
          code: 'INTERNAL',
          message: 'The action failed.',
          reason: 'OUTPUT_NOT_JSON_SAFE',
        });
        expect(response.text).not.toContain('internal-entity-secret');
        expect(f.errors[0]).toMatchObject({
          code: 'INTERNAL',
          status: 500,
          action: { group: 'cart', action: 'leak' },
          requestId: response.json().requestId,
        });
      },
    );

    it('serializes explicit toJSON values such as Date', async () => {
      const f = await fixture(platform);
      const response = await f.call('cart/leak', { kind: 'date' });
      expect(response.json().data).toEqual({
        when: '1970-01-02T00:00:00.000Z',
        nested: [1, 'two', null],
      });
    });

    it('redacts internal errors by default and exposes details only when enabled', async () => {
      const f = await fixture(platform);
      const response = await f.call('cart/crash');
      expect(response.status).toBe(500);
      expect(response.json().error).toEqual({
        code: 'INTERNAL',
        message: 'The action failed.',
      });
      expect(response.text).not.toContain('hunter2');
      expect(f.errors[0]?.error).toBeInstanceOf(Error);
      const debug = await fixture(platform, { exposeErrorDetails: true });
      const detailed = await debug.call('cart/crash');
      expect(detailed.json().error?.detail).toContain('hunter2');
      const leak = await debug.call('cart/leak', { kind: 'class' });
      expect(leak.json().error?.detail).toContain('$.entity');
    });

    it('lets application method filters take precedence over the envelope filter', async () => {
      const f = await fixture(platform);
      const response = await f.call('cart/filtered');
      expect(response.status).toBe(418);
      expect(response.json()).toEqual({ code: 'FILTERED' });
    });

    it('validates input and output with a Zod-compatible schema', async () => {
      const f = await fixture(platform);
      const invalid = await f.call('cart/checkout', {
        email: 'nope',
        items: [],
      });
      expect(invalid.status).toBe(400);
      const error = invalid.json().error;
      expect(error).toMatchObject({
        code: 'VALIDATION',
        reason: 'INPUT_SCHEMA',
      });
      expect(error?.issues?.map((issue) => issue.path)).toEqual([
        ['email'],
        ['items'],
      ]);
      const valid = await f.call('cart/checkout', {
        email: 'a@example.com',
        items: ['sku'],
        admin: true,
      });
      expect(valid.json().data).toEqual({ accepted: true });
      const broken = await f.call('cart/checkout', {
        email: 'a@example.com',
        items: ['broken-output'],
      });
      expect(broken.status).toBe(500);
      expect(broken.json().error?.reason).toBe('OUTPUT_SCHEMA');
    });

    it('routes explicit versions and returns redirect and notification effects', async () => {
      const f = await fixture(platform);
      const v2 = (await f.call('cart/checkout/v2')).json();
      expect(v2).toMatchObject({
        ok: true,
        data: { orderId: 42 },
        notifications: [{ level: 'success', message: 'Order placed' }],
      });
      const go = (await f.call('cart/go')).json();
      expect(go).toMatchObject({
        ok: true,
        data: null,
        redirect: { location: '/orders/42' },
      });
    });

    it('applies the rate limit hook per identity', async () => {
      const f = await fixture(platform, {
        rateLimit: createFixedWindowRateLimit({ limit: 2, windowMs: 60_000 }),
      });
      expect((await f.call('cart/whoami')).status).toBe(200);
      expect((await f.call('cart/whoami')).status).toBe(200);
      const limited = await f.call('cart/whoami');
      expect(limited.status).toBe(429);
      expect(limited.json().error).toMatchObject({
        code: 'RATE_LIMITED',
        reason: 'RATE_LIMIT',
      });
      expect(
        (await f.call('cart/whoami', undefined, { user: 'bob' })).status,
      ).toBe(200);
    });

    it('hands errors to host global filters in host envelope mode', async () => {
      @Catch()
      class HostFilter implements ExceptionFilter {
        constructor(
          @Inject(HttpAdapterHost) private readonly adapter: HttpAdapterHost,
        ) {}
        catch(error: unknown, host: ArgumentsHost): void {
          const status = error instanceof ActionError ? error.getStatus() : 500;
          this.adapter.httpAdapter.reply(
            host.switchToHttp().getResponse<unknown>(),
            {
              host: true,
              code: error instanceof ActionError ? error.code : 'OTHER',
            },
            status,
          );
        }
      }
      const f = await fixture(platform, { errorEnvelope: 'host' }, [
        { provide: APP_FILTER, useClass: HostFilter },
      ]);
      const response = await f.call('cart/whoami', undefined, {
        omit: ['x-nestvexa-csrf'],
      });
      expect(response.status).toBe(403);
      expect(response.json()).toEqual({ host: true, code: 'FORBIDDEN' });
      expect((await f.call('cart/whoami')).json().ok).toBe(true);
    });
  },
);

describe('server action host configuration', () => {
  it('supports registerAsync with injected policy and rejects static overrides', async () => {
    @ActionGroup('ping')
    class Ping {
      @ServerAction({ id: 'ping' }) ping() {
        return 'pong';
      }
    }
    const POLICY = Symbol('policy');
    const policy: ActionsHostOptions = {
      origin,
      resolveIdentity: () => sessions['alice'] ?? null,
      authorize: () => true,
    };
    @Module({
      providers: [{ provide: POLICY, useValue: policy }],
      exports: [POLICY],
    })
    class PolicyModule {}
    const module = await Test.createTestingModule({
      imports: [
        ActionsModule.registerAsync({
          groups: [Ping],
          imports: [PolicyModule],
          inject: [POLICY],
          useFactory: (value: ActionsHostOptions) => value,
        }),
      ],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    apps.push(app);
    await app.listen(0, '127.0.0.1');
    const response = await send(
      `${await app.getUrl()}/_nestvexa/actions/ping/ping`,
      {
        headers: {
          origin,
          'content-type': 'application/json',
          'x-nestvexa-csrf': sessions['alice']?.csrfToken ?? '',
        },
        body: '{}',
      },
    );
    expect(response.json()).toMatchObject({ ok: true, data: 'pong' });

    await expect(
      Test.createTestingModule({
        imports: [
          ActionsModule.registerAsync({
            groups: [Ping],
            useFactory: () => ({ ...policy, groups: [] }) as ActionsHostOptions,
          }),
        ],
      }).compile(),
    ).rejects.toThrow('Unknown actions host option groups');
  });

  it('supports bearer-style hosts with CSRF disabled and a custom prefix', async () => {
    @ActionGroup('token')
    class TokenActions {
      @ServerAction({ id: 'who' }) who(
        @ActionContext() context: ActionContext,
      ) {
        return context.identity.subject;
      }
    }
    const module = await Test.createTestingModule({
      imports: [
        ActionsModule.register({
          groups: [TokenActions],
          prefix: '/rpc',
          origin: [origin, 'https://admin.example'],
          csrf: { required: false },
          resolveIdentity: (request) => {
            const headers = Reflect.get(request, 'headers') as Record<
              string,
              string | undefined
            >;
            return headers['authorization'] === 'Bearer service-token'
              ? { subject: 'service' }
              : null;
          },
          authorize: (identity) => identity.subject === 'service',
        }),
      ],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    apps.push(app);
    await app.listen(0, '127.0.0.1');
    const url = `${await app.getUrl()}/rpc/token/who`;
    const ok = await send(url, {
      headers: {
        origin: 'https://admin.example',
        'content-type': 'application/json; charset=utf-8',
        authorization: 'Bearer service-token',
      },
      body: '{}',
    });
    expect(ok.json().data).toBe('service');
    const denied = await send(url, {
      headers: { origin, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(denied.status).toBe(401);
  });

  it('aborts in-flight actions on application shutdown', async () => {
    let observed: AbortSignal | undefined;
    const started = gate();
    @ActionGroup('jobs')
    class Jobs {
      @ServerAction({ id: 'wait' })
      async wait(@ActionSignal() signal: AbortSignal) {
        observed = signal;
        started.open();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return null;
      }
    }
    const module = await Test.createTestingModule({
      imports: [
        ActionsModule.register({
          groups: [Jobs],
          origin,
          resolveIdentity: () => sessions['alice'] ?? null,
          authorize: () => true,
        }),
      ],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const pending = send(`${await app.getUrl()}/_nestvexa/actions/jobs/wait`, {
      headers: {
        origin,
        'content-type': 'application/json',
        'x-nestvexa-csrf': sessions['alice']?.csrfToken ?? '',
      },
      body: '{}',
    }).catch((error: unknown) => error);
    await started.promise;
    await app.close();
    expect(observed?.aborted).toBe(true);
    await pending;
  });
});
