import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryStore } from './support/memory-store.js';
import { Test } from '@nestjs/testing';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  ParseIntPipe,
  Req,
  Scope,
  UseGuards,
} from '@nestjs/common';
import type {
  CanActivate,
  DynamicModule,
  ExecutionContext,
  INestApplication,
  InjectionToken,
  OptionalFactoryDependency,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  ActionInput,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '../packages/live/dist/index.js';
import type {
  LiveModuleAsyncOptions,
  LiveRuntimeFactoryOptions,
} from '../packages/live/dist/index.js';

const origin = 'http://localhost:3100';
const csrf = 'async-fixture-csrf-012345678901234567890123456789';
const resources: {
  root: string;
  renderer: HbsEngine;
  app?: INestApplication;
}[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app?.close();
    await resource.renderer.dispose();
    // Only directories returned by this fixture's mkdtemp under the OS temp root are removed.
    if (
      dirname(resolve(resource.root)) !== resolve(tmpdir()) ||
      !resource.root.includes('nestvexa-live-async-')
    )
      throw new Error('Unsafe fixture cleanup path');
    await rm(resource.root, { recursive: true, force: true });
  }
});

@Injectable({ scope: Scope.REQUEST })
class RequestInfo {
  readonly id = randomUUID();
  constructor(@Inject(REQUEST) readonly request: object) {}
}
@Injectable()
class AsyncGuard implements CanActivate {
  calls = 0;
  canActivate(context: ExecutionContext): boolean {
    this.calls++;
    const headers = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string> }>().headers;
    return headers['x-async-deny'] !== 'yes';
  }
}
@Module({
  providers: [RequestInfo, AsyncGuard],
  exports: [RequestInfo, AsyncGuard],
})
class ComponentServices {}

@LiveComponent({ name: 'async-counter', view: 'counter' })
@UseGuards(AsyncGuard)
class AsyncCounter {
  constructor(@Inject(RequestInfo) private readonly info: RequestInfo) {}
  @State() count = 0;
  @State() requestId = '';
  mount(): void {
    this.requestId = this.info.id;
  }
  @Action()
  @UseGuards(AsyncGuard)
  increment(): void {
    this.count++;
    this.requestId = this.info.id;
  }
  @Action()
  set(@ActionInput(new ParseIntPipe()) input: number): void {
    this.count = input;
  }
}
@Controller()
class MountController {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get('mount')
  async mount(@Req() req: object) {
    return { html: (await this.live.mount(AsyncCounter, req)).value };
  }
  @Get('api/health')
  health() {
    return { ok: true };
  }
}

async function renderer() {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-live-async-'));
  await writeFile(
    join(root, 'counter.hbs'),
    '<output>{{count}}</output><code>{{requestId}}</code>',
  );
  const engine = new HbsEngine({ root });
  await engine.initialize();
  const resource: {
    root: string;
    renderer: HbsEngine;
    app?: INestApplication;
  } = { root, renderer: engine };
  resources.push(resource);
  @Module({
    providers: [{ provide: HbsEngine, useValue: engine }],
    exports: [HbsEngine],
  })
  class RendererModule {}
  return { engine, module: RendererModule, resource };
}
function policy(engine: HbsEngine): LiveRuntimeFactoryOptions {
  return {
    renderer: engine,
    origin,
    // Fixed fixture identity exercises transport, not production authentication.
    resolveIdentity: async () => ({
      binding: 'async-fixture/session/principal',
      csrfToken: csrf,
    }),
    authorize: async (_identity, component, action) =>
      component === 'async-counter' &&
      ['$mount', '$sync', 'increment', 'set'].includes(action),
  };
}
function options(
  env: Awaited<ReturnType<typeof renderer>>,
): LiveModuleAsyncOptions<[HbsEngine]> {
  return {
    components: [AsyncCounter],
    imports: [env.module, ComponentServices],
    inject: [HbsEngine],
    useFactory: async (engine) => policy(engine),
  };
}
async function application(
  platform: 'express' | 'fastify',
  registration: DynamicModule,
  env: Awaited<ReturnType<typeof renderer>>,
) {
  const module = await Test.createTestingModule({
    imports: [registration],
    controllers: [MountController],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  env.resource.app = app;
  return { app, module };
}
async function send(
  app: INestApplication,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const base = new URL(await app.getUrl());
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise<{ status: number; body: string }>((done, reject) => {
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
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.setTimeout(5000, () =>
      outgoing.destroy(new Error('Async fixture HTTP timeout')),
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
function html(response: { body: string }): string {
  const value: unknown = JSON.parse(response.body);
  if (
    !value ||
    typeof value !== 'object' ||
    !('html' in value) ||
    typeof value.html !== 'string'
  )
    throw new Error('Invalid mount response');
  return value.html;
}
function deferred() {
  let release: () => void = () => {
    throw new Error('Missing deferred resolver');
  };
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release: () => release() };
}
/** Deliberately malformed host configuration for negative boundary tests. */
function invalid(value: unknown): LiveRuntimeFactoryOptions {
  return value as LiveRuntimeFactoryOptions;
}

describe.each(['express', 'fastify'] as const)(
  'async Live registration on %s',
  (platform) => {
    it('uses injected async policies and renderer through native guards, DTO pipes and request scopes', async () => {
      const env = await renderer();
      let factories = 0;
      const registration = LiveModule.registerAsync({
        ...options(env),
        useFactory: async (engine: HbsEngine) => {
          factories++;
          await Promise.resolve();
          return policy(engine);
        },
      });
      const { app } = await application(platform, registration, env);
      await app.listen(0, '127.0.0.1');
      const first = await send(app, '/mount');
      expect(first.status).toBe(200);
      const mounted = html(first);
      expect(mounted).toContain('<output>0</output>');
      const previousScope = /<code>([^<]+)<\/code>/.exec(mounted)?.[1];
      const denied = await send(
        app,
        '/_nestvexa/live/async-counter/increment',
        payload(mounted),
        { 'x-async-deny': 'yes' },
      );
      expect(denied.status).toBe(403);
      const accepted = await send(
        app,
        '/_nestvexa/live/async-counter/increment',
        payload(mounted),
      );
      expect(accepted.status).toBe(201);
      const value: unknown = JSON.parse(accepted.body);
      expect(value).toMatchObject({ state: { count: 1 } });
      if (
        !value ||
        typeof value !== 'object' ||
        !('state' in value) ||
        !value.state ||
        typeof value.state !== 'object'
      )
        throw new Error('Missing response state');
      expect(Reflect.get(value.state, 'requestId')).not.toBe(previousScope);
      const second = html(await send(app, '/mount'));
      expect(
        (
          await send(
            app,
            '/_nestvexa/live/async-counter/set',
            payload(second, '7'),
          )
        ).status,
      ).toBe(201);
      const third = html(await send(app, '/mount'));
      expect(
        (
          await send(
            app,
            '/_nestvexa/live/async-counter/set',
            payload(third, 'not-a-number'),
          )
        ).status,
      ).toBe(400);
      expect(JSON.parse((await send(app, '/api/health')).body)).toEqual({
        ok: true,
      });
      expect(factories).toBe(1);
      expect(env.engine).toBe(app.get(HbsEngine));
    });

    it('preserves explicit origin, CSRF and authorization rejection', async () => {
      const env = await renderer();
      const { app } = await application(
        platform,
        LiveModule.registerAsync({
          ...options(env),
          useFactory: async (engine: HbsEngine) => ({
            ...policy(engine),
            authorize: async (_identity, _component, action) =>
              action === '$mount',
          }),
        }),
        env,
      );
      await app.listen(0, '127.0.0.1');
      const mounted = html(await send(app, '/mount'));
      expect(
        (
          await send(
            app,
            '/_nestvexa/live/async-counter/increment',
            payload(mounted),
            { origin: 'https://attacker.invalid' },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await send(
            app,
            '/_nestvexa/live/async-counter/increment',
            payload(mounted),
            { 'x-nestvexa-csrf': 'bad' },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await send(
            app,
            '/_nestvexa/live/async-counter/increment',
            payload(mounted),
          )
        ).status,
      ).toBe(403);
    });

    it('rejects request-scoped configuration before accepting traffic without rejecting request-scoped components', async () => {
      const env = await renderer();
      @Injectable({ scope: Scope.REQUEST })
      class RequestConfiguration {}
      @Module({
        providers: [RequestConfiguration],
        exports: [RequestConfiguration],
      })
      class RequestConfigurationModule {}
      let calls = 0;
      const registration = LiveModule.registerAsync({
        components: [AsyncCounter],
        imports: [env.module, ComponentServices, RequestConfigurationModule],
        inject: [RequestConfiguration],
        useFactory: () => {
          calls++;
          return policy(env.engine);
        },
      });
      const { app } = await application(platform, registration, env);
      await expect(app.init()).rejects.toThrow('singleton scope');
      expect(calls).toBe(0);
    });

    it('snapshots caller component/import/inject arrays and route values while an async factory is pending', async () => {
      const env = await renderer();
      const entered = deferred();
      const resume = deferred();
      const components = [AsyncCounter];
      const imports = [env.module, ComponentServices];
      const dependency: OptionalFactoryDependency = {
        token: HbsEngine,
        optional: true,
      };
      const inject: (InjectionToken | OptionalFactoryDependency)[] = [
        dependency,
      ];
      const configuration = {
        components,
        imports,
        inject,
        endpoint: '/fixed/live',
        basePath: '/host',
        useFactory: async (engine: HbsEngine) => {
          entered.release();
          await resume.wait;
          return policy(engine);
        },
      };
      const registration = LiveModule.registerAsync(configuration);
      const compilation = application(platform, registration, env);
      await entered.wait;
      components.splice(0);
      imports.splice(0);
      inject.splice(0);
      dependency.token = Symbol('mutated');
      dependency.optional = false;
      configuration.endpoint = '/mutated/live';
      configuration.basePath = '/wrong';
      configuration.useFactory = async () => {
        throw new Error('Mutated caller factory must not run');
      };
      resume.release();
      const { app } = await compilation;
      app.setGlobalPrefix('host');
      await app.listen(0, '127.0.0.1');
      const mounted = html(await send(app, '/host/mount'));
      expect(mounted).toContain(
        'data-nv-endpoint="/host/fixed/live/async-counter"',
      );
      expect(
        (
          await send(
            app,
            '/host/fixed/live/async-counter/increment',
            payload(mounted),
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await send(
            app,
            '/host/mutated/live/async-counter/increment',
            payload(mounted),
          )
        ).status,
      ).toBe(404);
    });

    it('isolates async state owners and shutdown between application containers', async () => {
      const first = await renderer();
      const second = await renderer();
      const firstHost = await application(
        platform,
        LiveModule.registerAsync(options(first)),
        first,
      );
      const secondHost = await application(
        platform,
        LiveModule.registerAsync(options(second)),
        second,
      );
      await firstHost.app.listen(0, '127.0.0.1');
      await secondHost.app.listen(0, '127.0.0.1');
      const mounted = html(await send(firstHost.app, '/mount'));
      expect(
        (
          await send(
            secondHost.app,
            '/_nestvexa/live/async-counter/increment',
            payload(mounted),
          )
        ).status,
      ).toBe(410);
      await firstHost.app.close();
      expect((await send(secondHost.app, '/mount')).status).toBe(200);
      expect(memoryStore(firstHost.app.get(LiveRuntime)).size).toBe(0);
    });
  },
);

describe('async Live startup configuration boundaries', () => {
  it.each([
    'components',
    'endpoint',
    'basePath',
    'imports',
    'definitions',
    'unknown',
  ])('rejects a runtime factory attempting to supply %s', async (key) => {
    const env = await renderer();
    await expect(
      Test.createTestingModule({
        imports: [
          LiveModule.registerAsync({
            ...options(env),
            useFactory: async (engine: HbsEngine) =>
              invalid({ ...policy(engine), [key]: [] }),
          }),
        ],
      }).compile(),
    ).rejects.toThrow('static registration or unknown options');
  });
  it.each([
    ['origin path', { origin: 'https://example.test/path' }],
    ['origin slash', { origin: 'https://example.test/' }],
    ['non-HTTP origin', { origin: 'file:///tmp' }],
    ['missing identity', { resolveIdentity: undefined }],
    ['missing authorization', { authorize: undefined }],
    ['null renderer', { renderer: null }],
    [
      'incomplete renderer',
      {
        renderer: {
          render() {
            return '';
          },
        },
      },
    ],
    ['zero rate', { maxRequestsPerMinute: 0 }],
    ['fractional rate', { maxRequestsPerMinute: 1.5 }],
    ['NaN rate', { maxRequestsPerMinute: NaN }],
    ['invalid store', { store: {} }],
  ])('rejects %s before startup', async (_name, override) => {
    const env = await renderer();
    await expect(
      Test.createTestingModule({
        imports: [
          LiveModule.registerAsync({
            ...options(env),
            useFactory: async (engine: HbsEngine) =>
              invalid({ ...policy(engine), ...override }),
          }),
        ],
      }).compile(),
    ).rejects.toThrow();
  });
  it('rejects factory accessors without executing them', async () => {
    const env = await renderer();
    let reads = 0;
    const value = Object.defineProperty(policy(env.engine), 'origin', {
      get() {
        reads++;
        return origin;
      },
    });
    await expect(
      Test.createTestingModule({
        imports: [
          LiveModule.registerAsync({
            ...options(env),
            useFactory: () => value,
          }),
        ],
      }).compile(),
    ).rejects.toThrow('data properties');
    expect(reads).toBe(0);
  });
  it('propagates a rejected host factory instead of installing a partial runtime', async () => {
    const env = await renderer();
    await expect(
      Test.createTestingModule({
        imports: [
          LiveModule.registerAsync({
            ...options(env),
            useFactory: async () => {
              throw new Error('Host configuration unavailable');
            },
          }),
        ],
      }).compile(),
    ).rejects.toThrow('Host configuration unavailable');
  });
  it('rejects duplicate component owners across separate async modules', async () => {
    const env = await renderer();
    await expect(
      Test.createTestingModule({
        imports: [
          LiveModule.registerAsync(options(env)),
          LiveModule.registerAsync(options(env)),
        ],
      }).compile(),
    ).rejects.toThrow('Duplicate Live component registration');
  });
  it.each([
    '/bad/',
    '/bad/../route',
    'https://example.test/live',
    '/bad%2froute',
    '/bad\n',
    '/bad\r',
  ])(
    'rejects invalid static route %s before evaluating factories',
    (endpoint) => {
      let calls = 0;
      expect(() =>
        LiveModule.registerAsync({
          components: [AsyncCounter],
          endpoint,
          useFactory: () => {
            calls++;
            throw new Error('Factory must not execute');
          },
        }),
      ).toThrow('endpoint');
      expect(calls).toBe(0);
    },
  );
  it.each(['endpoint', 'basePath'] as const)(
    'rejects a null %s rather than defaulting it',
    (key) => {
      expect(() =>
        LiveModule.registerAsync({
          components: [AsyncCounter],
          [key]: null,
          useFactory: () => {
            throw new Error('Factory must not execute');
          },
        } as unknown as LiveModuleAsyncOptions),
      ).toThrow(key === 'endpoint' ? 'endpoint' : 'base path');
    },
  );
  it.each(['/host\n', '/host\r'])(
    'rejects newline public prefix %j',
    (basePath) => {
      expect(() =>
        LiveModule.registerAsync({
          components: [AsyncCounter],
          basePath,
          useFactory: () => {
            throw new Error('Factory must not execute');
          },
        }),
      ).toThrow('base path');
    },
  );
});
