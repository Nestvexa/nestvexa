import 'reflect-metadata';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  ParseIntPipe,
  Render,
  Req,
  Scope,
  UseGuards,
  VersioningType,
} from '@nestjs/common';
import type {
  CanActivate,
  DynamicModule,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Action,
  ActionInput,
  HbsEngine,
  LiveComponent,
  LiveRuntime,
  NestvexaBrowserService,
  NestvexaModule,
  State,
  configureNestvexa,
} from '../packages/nestvexa/dist/index.js';
import type {
  NestvexaLiveOptions,
  NestvexaLivePolicies,
} from '../packages/nestvexa/dist/index.js';
import { NestvexaAssetsService } from '../packages/nestvexa/dist/assets.js';

const origin = 'http://localhost:3100';
const csrf = 'umbrella-fixture-csrf-012345678901234567890123456789';
const resources: { root: string; app?: INestApplication }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) {
    await resource.app?.close();
    // Cleanup is restricted to directories produced by this fixture's mkdtemp.
    if (
      dirname(resolve(resource.root)) !== resolve(tmpdir()) ||
      !resource.root.includes('nestvexa-umbrella-live-')
    )
      throw new Error('Unsafe fixture cleanup path');
    await rm(resource.root, { recursive: true, force: true });
  }
});

@Injectable({ scope: Scope.REQUEST })
class RequestIdentity {
  readonly id = randomUUID();
}
@Injectable()
class MethodGuard implements CanActivate {
  calls = 0;
  canActivate(context: ExecutionContext): boolean {
    this.calls++;
    const { headers } = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    return headers['x-umbrella-method-deny'] !== 'yes';
  }
}
@Injectable()
class GlobalGuard implements CanActivate {
  calls = 0;
  canActivate(context: ExecutionContext): boolean {
    this.calls++;
    const { headers } = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    return headers['x-umbrella-global-deny'] !== 'yes';
  }
}
@Module({
  providers: [RequestIdentity, MethodGuard],
  exports: [RequestIdentity, MethodGuard],
})
class ComponentDependencies {}

@LiveComponent({ name: 'umbrella-counter', view: 'counter' })
class Counter {
  constructor(
    @Inject(RequestIdentity) private readonly identity: RequestIdentity,
  ) {}
  @State() count = 0;
  @State() requestId = '';
  mount(): void {
    this.requestId = this.identity.id;
  }
  @Action()
  @UseGuards(MethodGuard)
  increment(): void {
    this.count++;
    this.requestId = this.identity.id;
  }
  @Action()
  set(@ActionInput(new ParseIntPipe()) value: number): void {
    this.count = value;
  }
}
@Controller()
class Pages {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get()
  @Render('home')
  async home(@Req() req: object) {
    return {
      component: await this.live.mount(Counter, req),
      unsafe: '<script>untrusted()</script>',
      nonce: 'umbrella+nonce/0123456789==',
    };
  }
  @Get('api/health')
  health() {
    return { ok: true };
  }
}

function policies(): NestvexaLivePolicies {
  return {
    origin,
    // Deterministic fixture identity tests transport; applications must use host sessions/auth.
    resolveIdentity: (req) => {
      const headers: unknown = Reflect.get(req, 'headers');
      const owner: unknown =
        typeof headers === 'object' && headers !== null
          ? Reflect.get(headers, 'x-umbrella-owner')
          : undefined;
      return {
        binding: `fixture-session/${typeof owner === 'string' ? owner : 'fixture-owner'}`,
        csrfToken: csrf,
      };
    },
    authorize: (_identity, component, action) =>
      component === 'umbrella-counter' &&
      ['$mount', '$sync', 'increment', 'set'].includes(action),
  };
}
async function templates() {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-umbrella-live-'));
  const resource: { root: string; app?: INestApplication } = { root };
  resources.push(resource);
  await writeFile(
    join(root, 'counter.hbs'),
    '<output>{{count}}</output><code>{{requestId}}</code>',
  );
  await writeFile(
    join(root, 'home.hbs'),
    '<main><p>{{unsafe}}</p>{{component}}</main>',
  );
  await writeFile(
    join(root, 'layout.hbs'),
    '<!doctype html><html><body>{{{body}}}{{nvScripts nonce=nonce}}</body></html>',
  );
  return resource;
}
function registration(
  overrides: Partial<NestvexaLiveOptions<[]>> = {},
): NestvexaLiveOptions<[]> {
  return {
    components: [Counter],
    imports: [ComponentDependencies],
    useFactory: async () => policies(),
    ...overrides,
  };
}
async function application(
  platform: 'express' | 'fastify',
  resource: Awaited<ReturnType<typeof templates>>,
  registration: DynamicModule,
) {
  const module = await Test.createTestingModule({
    imports: [registration],
    controllers: [Pages],
    providers: [GlobalGuard],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  resource.app = app;
  app.useGlobalGuards(app.get(GlobalGuard));
  return app;
}
interface Response {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
async function send(
  app: INestApplication,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const base = new URL(await app.getUrl());
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((done, reject) => {
    const outgoing = request(
      {
        hostname: base.hostname,
        port: base.port,
        path,
        method: text === undefined ? 'GET' : 'POST',
        headers: {
          ...(text === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': String(Buffer.byteLength(text)),
                origin,
                'x-nestvexa-csrf': csrf,
              }),
          ...headers,
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: unknown) => {
          if (Buffer.isBuffer(chunk)) chunks.push(chunk);
          else outgoing.destroy(new Error('Unexpected HTTP chunk'));
        });
        incoming.on('error', reject);
        incoming.on('end', () =>
          done({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.setTimeout(5000, () =>
      outgoing.destroy(new Error('Umbrella fixture HTTP timeout')),
    );
    outgoing.end(text);
  });
}
function payload(html: string, input: unknown = null) {
  const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
  if (!snapshot) throw new Error('Missing fixture snapshot');
  return {
    protocol: 'nestvexa-live/1',
    requestId: randomUUID(),
    snapshot,
    revision: 0,
    updates: {},
    input,
  };
}
function objectJson(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Missing object response');
  return value as Record<string, unknown>;
}
/** Deliberately malformed host configurations exercise runtime validation beyond TypeScript. */
function invalidOptions(value: unknown): NestvexaLiveOptions<[]> {
  return value as NestvexaLiveOptions<[]>;
}
function invalidPolicies(value: unknown): NestvexaLivePolicies {
  return value as NestvexaLivePolicies;
}

describe.each(['express', 'fastify'] as const)(
  'integrated umbrella Live on %s',
  (platform) => {
    it('shares one HBS renderer for escaped MVC layouts and isolated request-scoped Live actions', async () => {
      const resource = await templates();
      const app = await application(
        platform,
        resource,
        NestvexaModule.forRoot(
          {
            views: { root: resource.root, layout: 'layout' },
            live: { enabled: true },
          },
          registration(),
        ),
      );
      const engine = app.get(HbsEngine);
      const initialize = vi.spyOn(engine, 'initialize');
      const dispose = vi.spyOn(engine, 'dispose');
      await Promise.all([configureNestvexa(app), configureNestvexa(app)]);
      await app.listen(0, '127.0.0.1');
      const page = await send(app, '/');
      expect(page.status).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');
      expect(page.body).toContain('<!doctype html>');
      expect(page.body).toContain('&lt;script&gt;untrusted()&lt;/script&gt;');
      expect(page.body).toContain('<output>0</output>');
      expect(page.body).toContain(
        'data-nv-endpoint="/_nestvexa/live/umbrella-counter"',
      );
      expect(page.body).toContain(
        '<script type="module" src="/_nestvexa/boot.js" nonce="umbrella+nonce/0123456789=="></script>',
      );
      const scope = /<code>([^<]+)<\/code>/.exec(page.body)?.[1];
      expect(scope).toBeDefined();
      expect(
        (
          await send(
            app,
            '/_nestvexa/live/umbrella-counter/increment',
            payload(page.body),
            { 'x-umbrella-method-deny': 'yes' },
          )
        ).status,
      ).toBe(403);
      const accepted = await send(
        app,
        '/_nestvexa/live/umbrella-counter/increment',
        payload(page.body),
      );
      expect(accepted.status).toBe(201);
      const value = objectJson(accepted.body);
      expect(value).toMatchObject({
        component: { revision: 1 },
        state: { count: 1 },
      });
      expect(typeof value['html']).toBe('string');
      expect(value['html']).toContain('<output>1</output>');
      expect(value['html']).not.toContain('<!doctype html>');
      expect(value['html']).not.toContain('<script');
      expect(value['html']).not.toContain(`<code>${scope}</code>`);
      const second = await send(app, '/');
      expect(second.body).toContain('<output>0</output>');
      expect(
        (
          await send(
            app,
            '/_nestvexa/live/umbrella-counter/set',
            payload(second.body, '7'),
          )
        ).status,
      ).toBe(201);
      const third = await send(app, '/');
      expect(
        (
          await send(
            app,
            '/_nestvexa/live/umbrella-counter/set',
            payload(third.body, 'bad'),
          )
        ).status,
      ).toBe(400);
      expect(objectJson((await send(app, '/api/health')).body)).toEqual({
        ok: true,
      });
      expect(initialize).toHaveBeenCalledTimes(1);
      const browser = app.get(NestvexaBrowserService);
      await app.close();
      delete resource.app;
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(() => browser.getBootUrl()).toThrow('shut down');
    });

    it('serves explicit version-neutral boot/assets under a global prefix and host guards', async () => {
      const resource = await templates();
      const streams = { summary: { endpoint: '/host/v1/report' } };
      const app = await application(
        platform,
        resource,
        NestvexaModule.forRoot(
          {
            views: { root: resource.root, layout: 'layout' },
            live: { enabled: true },
          },
          registration({
            basePath: '/host/v1',
            browser: {
              basePath: '/host',
              path: '/ui',
              assetsPath: '/static',
              streams,
            },
          }),
        ),
      );
      app.setGlobalPrefix('host');
      app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
      await configureNestvexa(app);
      await app.listen(0, '127.0.0.1');
      const browser = app.get(NestvexaBrowserService);
      streams.summary.endpoint = '/changed-after-registration';
      expect(browser.getBootUrl()).toBe('/host/ui/boot.js');
      const boot = await send(app, browser.getBootUrl());
      expect(boot.status).toBe(200);
      expect(boot.headers['cache-control']).toBe('no-store');
      expect(boot.headers['content-type']).toContain('text/javascript');
      expect(boot.headers['x-content-type-options']).toBe('nosniff');
      expect(boot.body).toContain('startLiveAlpine');
      expect(boot.body).toContain('"summary":{"endpoint":"/host/v1/report"}');
      expect(boot.body).not.toContain('/changed-after-registration');
      expect(boot.body).not.toContain(csrf);
      const manifest = app.get(NestvexaAssetsService).getManifest();
      for (const url of Object.values(manifest.entries)) {
        expect(url).toMatch(/^\/host\/static\/[a-f0-9]{64}\//);
        expect(boot.body).toContain(JSON.stringify(url));
        const response = await send(app, url);
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toContain('immutable');
        expect(
          (await send(app, url, undefined, { 'x-umbrella-global-deny': 'yes' }))
            .status,
        ).toBe(403);
      }
      expect((await send(app, '/host/v1/ui/boot.js')).status).toBe(404);
      expect((await send(app, '/ui/boot.js')).status).toBe(404);
      expect(
        (
          await send(app, browser.getBootUrl(), undefined, {
            'x-umbrella-global-deny': 'yes',
          })
        ).status,
      ).toBe(403);
      const page = await send(app, '/host/v1');
      expect(page.status).toBe(200);
      expect(page.body).toContain(
        'data-nv-endpoint="/host/v1/_nestvexa/live/umbrella-counter"',
      );
      expect(page.body).toContain('src="/host/ui/boot.js"');
      expect(
        (
          await send(
            app,
            '/host/v1/_nestvexa/live/umbrella-counter/increment',
            payload(page.body),
          )
        ).status,
      ).toBe(201);
    });

    it('enforces CSRF, origin, owner binding, monotonic revision and explicit action policies', async () => {
      const resource = await templates();
      const authorize = vi.fn(policies().authorize);
      const app = await application(
        platform,
        resource,
        NestvexaModule.forRoot(
          {
            views: { root: resource.root, layout: 'layout' },
            live: { enabled: true },
          },
          registration({ useFactory: () => ({ ...policies(), authorize }) }),
        ),
      );
      await configureNestvexa(app);
      await app.listen(0, '127.0.0.1');
      const page = await send(app, '/', undefined, {
        'x-umbrella-owner': 'owner-a',
      });
      const body = payload(page.body);
      const endpoint = '/_nestvexa/live/umbrella-counter/increment';
      expect(
        (
          await send(app, endpoint, body, {
            origin: 'https://attacker.invalid',
            'x-umbrella-owner': 'owner-a',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await send(app, endpoint, body, {
            'x-nestvexa-csrf': 'bad',
            'x-umbrella-owner': 'owner-a',
          })
        ).status,
      ).toBe(403);
      expect(
        (await send(app, endpoint, body, { 'x-umbrella-owner': 'owner-b' }))
          .status,
      ).toBe(410);
      const accepted = await send(app, endpoint, body, {
        'x-umbrella-owner': 'owner-a',
      });
      expect(accepted.status).toBe(201);
      expect(
        (
          await send(
            app,
            endpoint,
            { ...body, requestId: randomUUID() },
            { 'x-umbrella-owner': 'owner-a' },
          )
        ).status,
      ).toBe(409);
      expect(authorize).toHaveBeenCalledWith(
        expect.objectContaining({ binding: 'fixture-session/owner-a' }),
        'umbrella-counter',
        'increment',
      );
      expect(
        (await send(app, '/_nestvexa/live/umbrella-counter/constructor', body))
          .status,
      ).toBe(404);
      expect(
        (await send(app, '/_nestvexa/live/umbrella-counter/mount', body))
          .status,
      ).toBe(404);
      authorize.mockImplementation(
        (_identity, _component, action) => action === '$mount',
      );
      const forbidden = await send(app, '/', undefined, {
        'x-umbrella-owner': 'owner-a',
      });
      expect(forbidden.status).toBe(200);
      expect(
        (
          await send(app, endpoint, payload(forbidden.body), {
            'x-umbrella-owner': 'owner-a',
          })
        ).status,
      ).toBe(403);
    });

    it('uses imported singleton providers for asynchronous core config and Live policy factories exactly once', async () => {
      const resource = await templates();
      const value = { root: resource.root, configCalls: 0, policyCalls: 0 };
      const token = Symbol('umbrella-host-configuration');
      @Module({
        providers: [{ provide: token, useValue: value }],
        exports: [token],
      })
      class HostConfiguration {}
      const module = NestvexaModule.forRootAsync(
        {
          imports: [HostConfiguration],
          inject: [token],
          useFactory: async (host: typeof value) => {
            await Promise.resolve();
            host.configCalls++;
            return {
              views: { root: host.root, layout: 'layout' },
              live: { enabled: true },
            };
          },
        },
        {
          components: [Counter],
          imports: [ComponentDependencies, HostConfiguration],
          inject: [token],
          useFactory: async (host: typeof value) => {
            await Promise.resolve();
            host.policyCalls++;
            return policies();
          },
        },
      );
      const app = await application(platform, resource, module);
      await configureNestvexa(app);
      await app.listen(0, '127.0.0.1');
      expect((await send(app, '/')).status).toBe(200);
      expect((await send(app, '/')).status).toBe(200);
      expect(value.configCalls).toBe(1);
      expect(value.policyCalls).toBe(1);
    });

    it('leaves browser startup host-owned in manual mode while retaining explicit assets and Live', async () => {
      const resource = await templates();
      const app = await application(
        platform,
        resource,
        NestvexaModule.forRoot(
          {
            views: { root: resource.root },
            live: { enabled: true },
          },
          registration({ browser: { mode: 'manual' } }),
        ),
      );
      await configureNestvexa(app);
      await app.listen(0, '127.0.0.1');
      const page = await send(app, '/');
      expect(page.status).toBe(200);
      expect(page.body).toContain('<output>0</output>');
      expect(page.body).not.toContain('<script');
      expect((await send(app, '/_nestvexa/boot.js')).status).toBe(404);
      expect(() => app.get(NestvexaBrowserService).getBootUrl()).toThrow(
        'host-owned',
      );
      expect(() => app.get(NestvexaBrowserService).scripts()).toThrow(
        'host-owned',
      );
      const manifest = app.get(NestvexaAssetsService).getManifest();
      expect((await send(app, manifest.entries.alpineAdapter)).status).toBe(
        200,
      );
      expect(
        (
          await send(
            app,
            '/_nestvexa/live/umbrella-counter/increment',
            payload(page.body),
          )
        ).status,
      ).toBe(201);
    });

    it('isolates state and shared renderer ownership between independently booted applications', async () => {
      const one = await templates();
      const two = await templates();
      const boot = (resource: typeof one) =>
        application(
          platform,
          resource,
          NestvexaModule.forRoot(
            {
              views: { root: resource.root },
              live: { enabled: true },
            },
            registration(),
          ),
        );
      const first = await boot(one);
      const second = await boot(two);
      await configureNestvexa(first);
      await configureNestvexa(second);
      await first.listen(0, '127.0.0.1');
      await second.listen(0, '127.0.0.1');
      const page = await send(first, '/');
      expect(first.get(HbsEngine)).not.toBe(second.get(HbsEngine));
      expect(
        (
          await send(
            second,
            '/_nestvexa/live/umbrella-counter/increment',
            payload(page.body),
          )
        ).status,
      ).toBe(410);
      await first.close();
      delete one.app;
      expect((await send(second, '/')).status).toBe(200);
      expect(
        (await send(second, second.get(NestvexaBrowserService).getBootUrl()))
          .status,
      ).toBe(200);
    });
  },
);

describe('umbrella setup validation boundaries', () => {
  it.each([null, false])(
    'rejects an explicitly malformed registration: %s',
    (live) => {
      expect(() => NestvexaModule.forRoot({}, invalidOptions(live))).toThrow(
        'Invalid umbrella Live registration',
      );
    },
  );
  it.each([
    [
      'Live enabled without registration',
      { live: { enabled: true } },
      undefined,
      'registration',
    ],
    ['registration without Live enabled', {}, registration(), 'registration'],
    [
      'CSRF disabled',
      { live: { enabled: true }, security: { csrf: false } },
      registration(),
      'CSRF',
    ],
    [
      'live.client differing from the browser mode',
      { live: { enabled: true, client: 'manual' } },
      registration(),
      'must match the Live browser mode',
    ],
    [
      'action authorization disabled',
      {
        live: { enabled: true },
        security: { requireAuthorizedActions: false },
      },
      registration(),
      'authorized actions',
    ],
  ] as const)(
    'rejects %s during Nest startup',
    async (_name, options, live, expected) => {
      await expect(
        Test.createTestingModule({
          imports: [NestvexaModule.forRoot(options, live)],
        }).compile(),
      ).rejects.toThrow(expected);
    },
  );

  it.each([
    ['renderer override', { ...policies(), renderer: {} }],
    ['late route override', { ...policies(), endpoint: '/late' }],
    ['unknown policy', { ...policies(), surprise: true }],
    ['null policies', null],
  ])('rejects %s returned by a policy factory', async (_name, policies) => {
    await expect(
      Test.createTestingModule({
        imports: [
          NestvexaModule.forRoot(
            { live: { enabled: true } },
            registration({ useFactory: () => invalidPolicies(policies) }),
          ),
        ],
      }).compile(),
    ).rejects.toThrow('Invalid umbrella Live policies');
  });

  it('does not evaluate configuration accessors', () => {
    let reads = 0;
    const value = { ...registration() };
    Object.defineProperty(value, 'browser', {
      get() {
        reads++;
        throw new Error('getter executed');
      },
    });
    expect(() =>
      NestvexaModule.forRoot({ live: { enabled: true } }, value),
    ).toThrow('Invalid umbrella Live registration');
    expect(reads).toBe(0);
  });

  it.each([
    ['invalid mode', { mode: 'unknown' }],
    ['null mode', { mode: null }],
    ['null path', { path: null }],
    ['null asset path', { assetsPath: null }],
    ['external path', { path: 'https://attacker.invalid' }],
    ['traversal path', { assetsPath: '/../private' }],
    ['line-break path', { path: '/ui\n' }],
    [
      'boot route overlaps default assets',
      { path: '/_nestvexa/assets/current' },
    ],
    [
      'boot route overlaps custom assets',
      { path: '/static/current', assetsPath: '/static' },
    ],
    ['unknown option', { unknown: true }],
    ['null stream map', { streams: null }],
    ['array stream map', { streams: [] }],
    [
      'invalid stream identifier',
      { streams: { 'bad()': { endpoint: '/read' } } },
    ],
    [
      'prototype stream identifier',
      { streams: { constructor: { endpoint: '/read' } } },
    ],
    [
      'external stream',
      { streams: { summary: { endpoint: 'https://foreign.invalid/read' } } },
    ],
    ['stream query', { streams: { summary: { endpoint: '/read?secret=x' } } }],
    [
      'extra stream option',
      { streams: { summary: { endpoint: '/read', action: 'secret' } } },
    ],
    [
      'too many streams',
      {
        streams: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [
            `stream${index}`,
            { endpoint: '/read' },
          ]),
        ),
      },
    ],
    [
      'unused manual stream option',
      { mode: 'manual', streams: { summary: { endpoint: '/read' } } },
    ],
  ])('rejects %s without silently applying defaults', (_label, browser) => {
    // Deliberately malformed JavaScript-facing values bypass compile-time option types.
    const options = invalidOptions({ ...registration(), browser });
    expect(() =>
      NestvexaModule.forRoot({ live: { enabled: true } }, options),
    ).toThrow();
  });

  it('reports rejected host policy factories without accepting traffic', async () => {
    const error = new Error('host configuration unavailable');
    await expect(
      Test.createTestingModule({
        imports: [
          NestvexaModule.forRoot(
            { live: { enabled: true } },
            registration({
              useFactory: async () => {
                throw error;
              },
            }),
          ),
        ],
      }).compile(),
    ).rejects.toBe(error);
  });

  it('validates script helpers and CSP nonce without allowing HTML injection', async () => {
    const resource = await templates();
    const app = await application(
      'express',
      resource,
      NestvexaModule.forRoot(
        { views: { root: resource.root }, live: { enabled: true } },
        registration(),
      ),
    );
    await configureNestvexa(app);
    await app.init();
    const browser = app.get(NestvexaBrowserService);
    expect(browser.scripts().value).toBe(
      '<script type="module" src="/_nestvexa/boot.js"></script>',
    );
    for (const nonce of [
      '" onload="attack()',
      'x\n',
      'x\r',
      '',
      'x'.repeat(257),
    ])
      expect(() => browser.scripts(nonce)).toThrow('nonce');
    const engine = app.get(HbsEngine);
    for (const template of [
      '{{nvScripts "positional"}}',
      '{{nvScripts src="https://attacker.invalid"}}',
      '{{nvScripts nonce=nonce}}',
    ]) {
      await writeFile(join(resource.root, 'invalid.hbs'), template);
      await expect(
        engine.render('invalid', { nonce: '" onload="attack()' }),
      ).rejects.toThrow();
    }
    expect(
      await engine.render('layout', { body: 'safe', nonce: 'abc+/123==' }),
    ).toContain('nonce="abc+/123=="');
  });
});
