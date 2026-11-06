/**
 * Kernel services (master plan 5.1–5.2): extension hooks (CORE-034), error
 * envelope with correlation IDs and redacted logging (CORE-035),
 * RequestContextFactory (CORE-043), SecurityPolicyRegistry (CORE-047) and
 * DiagnosticsRegistry (CORE-048), unit-tested and integrated with Live on
 * Express and Fastify.
 */
import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CoreModule,
  DiagnosticsRegistry,
  FeatureCapabilityRegistry,
  NestvexaExceptionFilter,
  NestvexaExtensionHost,
  REDACTED,
  RequestContextFactory,
  SecurityPolicyRegistry,
  createRedactingLogger,
  defineExtension,
  exactOriginPolicy,
  redact,
} from '../packages/core/dist/index.js';
import type {
  DiagnosticRecord,
  NestvexaExtension,
} from '../packages/core/dist/index.js';
import {
  Action,
  LiveComponent,
  LiveRuntime,
  NestvexaModule,
  State,
  configureNestvexa,
} from '../packages/nestvexa/dist/index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

describe('redaction', () => {
  it('redacts sensitive keys, credentials in strings, cycles, depth and errors', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic['self'] = cyclic;
    const error = Object.assign(new Error('Bearer abcdefghijklmnop failed'), {
      password: 'hunter2',
    });
    const value = redact({
      user: 'ada',
      password: 'hunter2',
      'X-CSRF-Token': 'csrf-value',
      headers: { authorization: 'Basic dXNlcjpwYXNz', cookie: 'sid=1' },
      nested: { apiKey: 'k', session_id: 's', deep: { snapshot: 'tok' } },
      note: 'call with Bearer abcdefghijklmnopqrstuvwxyz',
      cyclic,
      error,
      list: [{ secret: 1 }, 2],
      fn: () => 'dropped',
    });
    expect(value).toEqual({
      user: 'ada',
      password: REDACTED,
      'X-CSRF-Token': REDACTED,
      headers: { authorization: REDACTED, cookie: REDACTED },
      nested: {
        apiKey: REDACTED,
        session_id: REDACTED,
        deep: { snapshot: REDACTED },
      },
      note: `call with Bearer ${REDACTED}`,
      cyclic: { name: 'loop', self: '[Circular]' },
      error: { name: 'Error', message: `Bearer ${REDACTED} failed` },
      list: [{ secret: REDACTED }, 2],
      fn: undefined,
    });
    expect(JSON.stringify(value)).not.toContain('hunter2');
    let deep: Record<string, unknown> = { leaf: true };
    for (let index = 0; index < 12; index++) deep = { deep };
    expect(JSON.stringify(redact(deep))).toContain('[Truncated]');
    expect(redact({ ssn: '1' }, { keys: ['ssn'] })).toEqual({ ssn: REDACTED });
    expect(() => redact({}, { keys: ['bad key!'] })).toThrow();
    // Getters are never evaluated.
    let evaluated = false;
    const accessor = Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        evaluated = true;
        return 'x';
      },
    });
    expect(redact(accessor)).toEqual({});
    expect(evaluated).toBe(false);
  });

  it('wraps a Nest logger so nothing sensitive reaches it', () => {
    const lines: unknown[][] = [];
    const base: LoggerService = {
      log: (...args: unknown[]) => lines.push(['log', ...args]),
      error: (...args: unknown[]) => lines.push(['error', ...args]),
      warn: (...args: unknown[]) => lines.push(['warn', ...args]),
    };
    const logger = createRedactingLogger(base);
    logger.log({ token: 't', ok: 1 });
    logger.error('auth Bearer abcdefghijklmnop', { password: 'p' });
    logger.debug?.('ignored: base has no debug');
    expect(lines).toEqual([
      ['log', { token: REDACTED, ok: 1 }],
      ['error', `auth Bearer ${REDACTED}`, { password: REDACTED }],
    ]);
  });
});

describe('DiagnosticsRegistry', () => {
  it('records typed events, metrics and spans with bounded, redacted primitive attributes', () => {
    let now = 1_000;
    const diagnostics = new DiagnosticsRegistry({
      bufferSize: 3,
      now: () => now,
    });
    const seen: DiagnosticRecord[] = [];
    const unsubscribe = diagnostics.subscribe((record) => seen.push(record));
    diagnostics.subscribe(() => {
      throw new Error('listener failure is isolated');
    });
    diagnostics.define({
      name: 'cache.hit',
      kind: 'metric',
      description: 'Cache hits',
    });
    diagnostics.event('user.login', {
      user: 'ada',
      token: 'secret-token',
      object: { nested: true } as unknown as string,
      note: `Bearer ${'a'.repeat(20)}`,
    });
    diagnostics.metric('cache.hit', 1, { region: 'eu' });
    const span = diagnostics.span('db.query', { table: 'users' });
    now += 25;
    span.end('error', { rows: 0 });
    span.end('ok');
    expect(seen.map((record) => record.kind)).toEqual([
      'event',
      'metric',
      'span',
    ]);
    expect(seen[0]?.attributes).toEqual({
      user: 'ada',
      token: REDACTED,
      note: `Bearer ${REDACTED}`,
    });
    expect(seen[2]).toMatchObject({
      kind: 'span',
      durationMs: 25,
      outcome: 'error',
      attributes: { table: 'users', rows: 0 },
    });
    expect(Object.isFrozen(seen[0])).toBe(true);
    diagnostics.event('extra');
    expect(diagnostics.recent().map((record) => record.name)).toEqual([
      'cache.hit',
      'db.query',
      'extra',
    ]);
    expect(diagnostics.recent({ kind: 'span' })).toHaveLength(1);
    unsubscribe();
    diagnostics.event('after');
    expect(seen).toHaveLength(4);
    // Kind mismatches, invalid names and non-finite metrics are rejected.
    expect(() => diagnostics.event('cache.hit')).toThrow(/metric/);
    expect(() => diagnostics.event('Bad Name')).toThrow();
    expect(() => diagnostics.metric('m', Number.NaN)).toThrow();
    const strict = new DiagnosticsRegistry({ strict: true });
    expect(() => strict.event('undefined.name')).toThrow(/Undefined/);
    expect(() =>
      diagnostics.define({
        name: 'cache.hit',
        kind: 'event',
        description: 'x',
      }),
    ).toThrow(/already defined/);
  });

  it('adapts to the Live instrumentation hook shape', () => {
    const diagnostics = new DiagnosticsRegistry();
    const hook = diagnostics.instrumentation();
    hook
      .start('nestvexa.live.action', { 'nestvexa.component': 'counter' })
      .end('ok', {
        'nestvexa.html_bytes': 12,
      });
    expect(diagnostics.recent({ prefix: 'nestvexa.live' })[0]).toMatchObject({
      kind: 'span',
      outcome: 'ok',
      attributes: {
        'nestvexa.component': 'counter',
        'nestvexa.html_bytes': 12,
      },
    });
  });
});

describe('SecurityPolicyRegistry', () => {
  it('validates, freezes, reports without functions and fails closed', async () => {
    const security = new SecurityPolicyRegistry();
    security.register(
      'origin',
      'live',
      exactOriginPolicy('https://app.example'),
    );
    security.register('csrf', 'live', {
      verify: (request) => Reflect.get(request, 'ok') === true,
    });
    security.register('action-authorization', 'live', {
      authorize: (_subject, resource, action) => {
        if (action === 'explode') throw new Error('policy bug');
        return resource === 'cart' && action === 'pay';
      },
    });
    security.register('snapshot', 'live', {
      storage: 'server',
      ttlMs: 900_000,
      bindsIdentity: true,
    });
    security.register('upload-quota', 'uploads', {
      maxFileBytes: 10,
      maxFiles: 2,
      maxTotalBytes: 15,
    });
    expect(security.originAllowed('live', 'https://app.example')).toBe(true);
    expect(security.originAllowed('live', 'https://app.example.evil')).toBe(
      false,
    );
    expect(security.originAllowed('live', undefined)).toBe(false);
    expect(security.originAllowed('other', 'https://app.example')).toBe(false);
    expect(await security.verifyCsrf('live', { ok: true })).toBe(true);
    expect(await security.verifyCsrf('live', { ok: 'yes' })).toBe(false);
    expect(await security.authorize('live', {}, 'cart', 'pay')).toBe(true);
    expect(await security.authorize('live', {}, 'cart', 'refund')).toBe(false);
    expect(await security.authorize('live', {}, 'cart', 'explode')).toBe(false);
    expect(await security.authorize('uploads', {}, 'cart', 'pay')).toBe(false);
    expect(security.uploadAllowed('uploads', [5, 10])).toBe(true);
    expect(security.uploadAllowed('uploads', [11])).toBe(false);
    expect(security.uploadAllowed('uploads', [10, 10])).toBe(false);
    expect(security.uploadAllowed('uploads', [1, 1, 1])).toBe(false);
    expect(security.uploadAllowed('live', [1])).toBe(false);
    expect(() =>
      security.require('live', ['csrf', 'origin', 'snapshot']),
    ).not.toThrow();
    expect(() => security.require('uploads', ['csrf'])).toThrow(
      /missing security policies: csrf/,
    );
    const report = security.report();
    expect(report).toEqual({
      live: {
        origin: { configured: true },
        csrf: { configured: true },
        'action-authorization': { configured: true },
        snapshot: { storage: 'server', ttlMs: 900_000, bindsIdentity: true },
      },
      uploads: {
        'upload-quota': { maxFileBytes: 10, maxFiles: 2, maxTotalBytes: 15 },
      },
    });
    expect(JSON.stringify(report)).not.toContain('function');
    expect(() =>
      security.register(
        'origin',
        'live',
        exactOriginPolicy('https://x.example'),
      ),
    ).toThrow(/Duplicate/);
    security.seal();
    expect(() =>
      security.register('csrf', 'uploads', { verify: () => true }),
    ).toThrow(/sealed/);
  });

  it('rejects unsafe or malformed policies', () => {
    const security = new SecurityPolicyRegistry();
    expect(() =>
      security.register('snapshot', 'live', {
        storage: 'server',
        ttlMs: 1000,
        bindsIdentity: false as unknown as true,
      }),
    ).toThrow(/bind state/);
    expect(() =>
      security.register('snapshot', 'live', {
        storage: 'browser' as unknown as 'server',
        ttlMs: 1000,
        bindsIdentity: true,
      }),
    ).toThrow(/storage/);
    expect(() =>
      security.register('upload-quota', 'u', {
        maxFileBytes: 0,
        maxFiles: 1,
        maxTotalBytes: 1,
      }),
    ).toThrow(/maxFileBytes/);
    expect(() =>
      security.register(
        'csrf',
        'u',
        {} as unknown as { verify(r: object): boolean },
      ),
    ).toThrow(/verify/);
    expect(() =>
      security.register('csrf', 'Bad Owner', { verify: () => true }),
    ).toThrow(/owner/);
    expect(() => exactOriginPolicy('https://app.example/path')).toThrow();
    expect(() => exactOriginPolicy('javascript:alert(1)')).toThrow();
  });
});

describe('RequestContextFactory', () => {
  it('builds one immutable context per request with a safe public subset', async () => {
    const factory = new RequestContextFactory({
      resolveTenant: () => 'tenant-a',
      resolveSession: () => 'session-secret-id',
      resolvePrincipal: () => ({ id: 'user-1', roles: ['admin'] }),
    });
    factory.contribute('locale', () => ({ language: 'en', rtl: false }));
    const request = { headers: { 'x-request-id': 'req-0123456789' } };
    const context = await factory.create(request);
    expect(await factory.create(request)).toBe(context);
    expect(context).toMatchObject({
      correlationId: 'req-0123456789',
      tenant: 'tenant-a',
      session: 'session-secret-id',
      principal: { id: 'user-1', roles: ['admin'] },
      extensions: { locale: { language: 'en', rtl: false } },
    });
    expect(context.cspNonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(context.public).toEqual({
      correlationId: 'req-0123456789',
      cspNonce: context.cspNonce,
      tenant: 'tenant-a',
      authenticated: true,
    });
    expect(JSON.stringify(context.public)).not.toMatch(
      /session-secret|user-1|admin/,
    );
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.public)).toBe(true);
    // Another request gets another nonce; the correlation ID is stable per request.
    const other = { headers: {} };
    const second = await factory.create(other);
    expect(second.cspNonce).not.toBe(context.cspNonce);
    expect(factory.correlationId(other)).toBe(second.correlationId);
  });

  it('rejects malformed correlation IDs and resolver output; resolver errors fail closed', async () => {
    const factory = new RequestContextFactory();
    for (const incoming of [
      'short',
      'has space 123456',
      'a\nb'.repeat(5),
      'x'.repeat(129),
    ])
      expect(
        factory.correlationId({ headers: { 'x-request-id': incoming } }),
      ).toMatch(/^[0-9a-f-]{36}$/);
    const untrusting = new RequestContextFactory({
      trustIncomingCorrelation: false,
    });
    expect(
      untrusting.correlationId({
        headers: { 'x-request-id': 'req-0123456789' },
      }),
    ).not.toBe('req-0123456789');
    await expect(
      new RequestContextFactory({ resolveTenant: () => '../other' }).create({}),
    ).rejects.toThrow(/tenant/);
    await expect(
      new RequestContextFactory({
        resolvePrincipal: () => ({ id: '' }),
      }).create({}),
    ).rejects.toThrow(/principal/);
    await expect(
      new RequestContextFactory({
        resolveTenant: () => {
          throw new Error('directory down');
        },
      }).create({}),
    ).rejects.toThrow(/directory down/);
    const contributing = new RequestContextFactory();
    contributing.contribute('bad', () => ({ nested: {} as unknown as string }));
    await expect(contributing.create({})).rejects.toThrow(/primitive/);
    expect(() => contributing.contribute('bad', () => undefined)).toThrow(
      /Duplicate/,
    );
    expect(
      () => new RequestContextFactory({ correlationHeader: 'Bad Header' }),
    ).toThrow();
  });
});

describe('extension hooks', () => {
  it('validates definitions', () => {
    expect(() => defineExtension({ name: 'Bad' })).toThrow(/name/);
    expect(() =>
      defineExtension({
        name: 'ok',
        register: 'nope',
      } as unknown as NestvexaExtension),
    ).toThrow(/register/);
    expect(() =>
      defineExtension({
        name: 'ok',
        unknownHook: () => undefined,
      } as unknown as NestvexaExtension),
    ).toThrow(/documented hooks/);
  });

  it('installs capabilities, policies and context contributions in order, then seals', async () => {
    const order: string[] = [];
    const first: NestvexaExtension = {
      name: 'audit',
      capabilities: { 'audit-log': { supported: true } },
      register: ({ security, diagnostics }) => {
        order.push('register:audit');
        security.register('upload-quota', 'audit', {
          maxFileBytes: 1,
          maxFiles: 1,
          maxTotalBytes: 1,
        });
        diagnostics.define({
          name: 'audit.write',
          kind: 'event',
          description: 'Audit write',
        });
      },
      contributeContext: () => ({ auditing: true }),
      shutdown: () => {
        order.push('shutdown:audit');
      },
    };
    const second: NestvexaExtension = {
      name: 'tracing',
      capabilities: {
        'html-streaming': { supported: false, reason: 'Not on this adapter' },
      },
      register: () => {
        order.push('register:tracing');
      },
      shutdown: () => {
        order.push('shutdown:tracing');
        throw new Error('cleanup failure is isolated');
      },
    };
    const module = await Test.createTestingModule({
      imports: [CoreModule.forRoot({}, { extensions: [first, second] })],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    await app.init();
    const capabilities = app.get(FeatureCapabilityRegistry);
    expect(capabilities.report()).toEqual({
      'audit-log': { supported: true },
      'html-streaming': { supported: false, reason: 'Not on this adapter' },
    });
    expect(() => capabilities.require('html-streaming')).toThrow(
      /Not on this adapter/,
    );
    expect(app.get(NestvexaExtensionHost).names()).toEqual([
      'audit',
      'tracing',
    ]);
    expect(app.get(SecurityPolicyRegistry).sealed).toBe(true);
    expect(() => capabilities.register('late', { supported: true })).toThrow(
      /sealed/,
    );
    const context = await app
      .get(RequestContextFactory)
      .create({ headers: {} });
    expect(context.extensions).toEqual({ audit: { auditing: true } });
    expect(
      app
        .get(DiagnosticsRegistry)
        .recent({ prefix: 'nestvexa.extension' })
        .map((record) => record.attributes['extension']),
    ).toEqual(['audit', 'tracing']);
    await app.close();
    expect(order).toEqual([
      'register:audit',
      'register:tracing',
      'shutdown:tracing',
      'shutdown:audit',
    ]);
  }, 60_000);

  it('rejects duplicate extension names at startup', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          CoreModule.forRoot(
            {},
            { extensions: [{ name: 'x' }, { name: 'x' }] },
          ),
        ],
      }).compile(),
    ).rejects.toThrow(/Duplicate extension/);
  });
});

@LiveComponent({ name: 'kernel-counter', view: 'kernel-counter' })
class KernelCounter {
  @State() count = 0;
  @Action() increment(): void {
    this.count++;
  }
  @Action() explode(): void {
    throw new Error('database password=hunter2 leaked in message');
  }
  @Action() refuse(): void {
    throw new HttpException({ statusCode: 422, code: 'CUSTOM_RULE' }, 422);
  }
}

const origin = 'http://127.0.0.1:3422';
const csrf = 'kernel-csrf-0123456789abcdefghijklmnopqrstu';

describe.each(['express', 'fastify'] as const)(
  'kernel services with integrated Live: %s',
  (platform) => {
    async function start() {
      const root = await mkdtemp(join(tmpdir(), 'nestvexa-kernel-'));
      cleanup.push(async () => {
        if (dirname(resolve(root)) !== resolve(tmpdir()))
          throw new Error('Unsafe cleanup');
        await rm(root, { recursive: true, force: true });
      });
      await writeFile(join(root, 'kernel-counter.hbs'), '<p>{{count}}</p>');
      const logged: unknown[] = [];
      const errorLogger: LoggerService = {
        log: () => undefined,
        warn: () => undefined,
        error: (...args: unknown[]) => logged.push(...args),
      };
      const module = await Test.createTestingModule({
        imports: [
          NestvexaModule.forRoot(
            { views: { root }, live: { enabled: true } },
            {
              components: [KernelCounter],
              useFactory: () => ({
                origin,
                maxRequestsPerMinute: 1_000,
                resolveIdentity: () => ({
                  binding: 'kernel/session/principal',
                  csrfToken: csrf,
                }),
                authorize: (_identity, _component, action) =>
                  action !== 'denied',
              }),
            },
            { errorLogger },
          ),
        ],
      }).compile();
      const app: INestApplication =
        platform === 'fastify'
          ? module.createNestApplication(new FastifyAdapter(), {
              logger: false,
            })
          : module.createNestApplication({ logger: false });
      app.useGlobalFilters(app.get(NestvexaExceptionFilter));
      await configureNestvexa(app);
      await app.listen(0, '127.0.0.1');
      cleanup.push(() => app.close());
      // Each call uses a freshly mounted component: a failing action
      // invalidates its state reference.
      const call = async (
        action: string,
        headers: Record<string, string> = {},
      ) => {
        const html = (
          await app.get(LiveRuntime).mount(KernelCounter, { headers: {} })
        ).value;
        const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '';
        const revision = 0;
        const response = await fetch(
          `${await app.getUrl()}/_nestvexa/live/kernel-counter/${action}`,
          {
            method: 'POST',
            headers: {
              origin,
              'content-type': 'application/json',
              'x-nestvexa-csrf': csrf,
              ...headers,
            },
            body: JSON.stringify({
              protocol: 'nestvexa-live/1',
              requestId: randomUUID(),
              snapshot,
              revision,
              updates: {},
              input: null,
            }),
          },
        );
        const body = (await response.json()) as Record<string, unknown>;
        return {
          status: response.status,
          header: response.headers.get('x-request-id'),
          body,
        };
      };
      return { app, call, logged };
    }

    it('adds correlation IDs to error envelopes and hides internals', async () => {
      const { call, logged } = await start();
      const forged = await call('increment', {
        'x-nestvexa-csrf': 'wrong',
        'x-request-id': 'trace-0123456789',
      });
      expect(forged).toEqual({
        status: 403,
        header: 'trace-0123456789',
        body: {
          statusCode: 403,
          code: 'CSRF_REJECTED',
          correlationId: 'trace-0123456789',
        },
      });
      const malformed = await call('increment', {
        'x-nestvexa-csrf': 'wrong',
        'x-request-id': 'bad id with spaces',
      });
      expect(malformed.body['correlationId']).toMatch(/^[0-9a-f-]{36}$/);
      expect(malformed.header).toBe(malformed.body['correlationId']);
      const custom = await call('refuse');
      expect(custom.body).toMatchObject({
        statusCode: 422,
        code: 'CUSTOM_RULE',
      });
      expect(typeof custom.body['correlationId']).toBe('string');
      expect(logged).toEqual([]);
      const failed = await call('explode');
      expect(failed.status).toBe(500);
      expect(failed.body).toEqual({
        statusCode: 500,
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        correlationId: failed.header,
      });
      expect(JSON.stringify(failed.body)).not.toContain('hunter2');
      // Exactly one server-error log line, carrying the correlation ID.
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        correlationId: failed.header,
        status: 500,
        error: { name: 'Error' },
      });
    });

    it('records Live spans in diagnostics and Live policies in the security registry', async () => {
      const { app, call } = await start();
      expect((await call('increment')).status).toBe(201);
      const diagnostics = app.get(DiagnosticsRegistry);
      const spans = diagnostics.recent({
        kind: 'span',
        prefix: 'nestvexa.live',
      });
      expect(spans.map((span) => span.name)).toEqual(
        expect.arrayContaining([
          'nestvexa.live.mount',
          'nestvexa.live.action',
          'nestvexa.live.render',
        ]),
      );
      expect(JSON.stringify(spans)).not.toContain(csrf);
      await call('explode');
      expect(
        diagnostics.recent({ prefix: 'nestvexa.error' }).at(-1)?.attributes,
      ).toMatchObject({ status: 500 });
      const security = app.get(SecurityPolicyRegistry);
      expect(security.report()['live']).toEqual({
        origin: { configured: true },
        'action-authorization': { configured: true },
        csrf: { configured: true },
        snapshot: { storage: 'server', ttlMs: 900_000, bindsIdentity: true },
      });
      expect(security.originAllowed('live', origin)).toBe(true);
      expect(security.originAllowed('live', 'http://127.0.0.1:9')).toBe(false);
      expect(
        await security.verifyCsrf('live', {
          headers: { 'x-nestvexa-csrf': csrf },
        }),
      ).toBe(true);
      expect(
        await security.verifyCsrf('live', {
          headers: { 'x-nestvexa-csrf': 'wrong' },
        }),
      ).toBe(false);
      expect(
        await security.authorize(
          'live',
          { binding: 'kernel/session/principal', csrfToken: csrf },
          'kernel-counter',
          'denied',
        ),
      ).toBe(false);
      expect(
        await security.authorize(
          'live',
          'not an identity',
          'kernel-counter',
          'increment',
        ),
      ).toBe(false);
    });
  },
);
