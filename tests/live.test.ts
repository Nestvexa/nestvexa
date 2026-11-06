import 'reflect-metadata';
import {
  BadRequestException,
  Catch,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Injectable,
  Module,
  Req,
  Scope,
  SetMetadata,
  UseFilters,
  UseGuards,
  UseInterceptors,
  UsePipes,
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
import { APP_GUARD, HttpAdapterHost, REQUEST } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryStore } from './support/memory-store.js';
import { tap } from 'rxjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  ActionInput,
  Computed,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  Locked,
  State,
} from '../packages/live/dist/index.js';

const origin = 'http://localhost:3100';
const csrf = 'host-generated-test-csrf-0123456789abcdef';
interface HostRequest {
  readonly headers: Record<string, string | undefined>;
  trace: string[];
}
interface Reply {
  readonly protocol: string;
  readonly requestId: string;
  readonly snapshot: string;
  readonly component: {
    readonly id: string;
    readonly name: string;
    readonly revision: number;
  };
  readonly state: Record<string, unknown>;
  readonly html: string;
}
interface Mount {
  readonly snapshot: string;
  readonly revision: number;
  readonly html: string;
}
const resources: { app: INestApplication; root: string; engine: HbsEngine }[] =
  [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    await resource.engine.dispose();
    await rm(resource.root, { recursive: true, force: true });
  }
});

async function fixture(platform: 'express' | 'fastify', basePath = '') {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-live-integration-'));
  const engine = new HbsEngine({ root });
  await writeFile(
    join(root, 'counter.hbs'),
    '<output>{{count}}</output><b>{{doubled}}</b><p>{{label}}</p><code>{{scopeId}}</code>',
  );
  await engine.initialize();
  const traces: string[][] = [];
  const scopeIds: string[] = [];
  const sessions = new Map([
    [
      'alice',
      { binding: 'tenant-a/session-alice/principal-alice', csrfToken: csrf },
    ],
    ['bob', { binding: 'tenant-b/session-bob/principal-bob', csrfToken: csrf }],
    [
      'denied',
      { binding: 'tenant-a/session-denied/principal-denied', csrfToken: csrf },
    ],
  ]);

  @Injectable({ scope: Scope.REQUEST })
  class RequestInfo {
    readonly id = randomUUID();
    readonly secret = 'server-provider-secret-never-render';
    constructor(@Inject(REQUEST) readonly request: HostRequest) {}
  }
  @Injectable()
  class GlobalGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<HostRequest>();
      request.trace ??= [];
      request.trace.push('global');
      if (request.headers['x-deny-global'])
        throw new ForbiddenException('global');
      return true;
    }
  }
  @Injectable()
  class ComponentGuard implements CanActivate {
    constructor(@Inject(RequestInfo) private readonly info: RequestInfo) {}
    canActivate(context: ExecutionContext): boolean {
      this.info.request.trace.push('class');
      if (
        Reflect.getMetadata('test:class-role', context.getClass()) !== 'member'
      )
        throw new Error('Class policy metadata was lost');
      scopeIds.push(this.info.id);
      if (this.info.request.headers['x-deny-class'])
        throw new ForbiddenException('class');
      return true;
    }
  }
  @Injectable()
  class MethodGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<HostRequest>();
      request.trace.push('method');
      if (
        Reflect.getMetadata('test:method-role', context.getHandler()) !==
        'editor'
      )
        throw new Error('Method policy metadata was lost');
      if (request.headers['x-deny-method'])
        throw new ForbiddenException('method');
      return true;
    }
  }
  @Injectable()
  class MethodPipe implements PipeTransform {
    transform(value: unknown, metadata: ArgumentMetadata): unknown {
      if (metadata.type !== 'body') return value;
      if (
        typeof value !== 'object' ||
        value === null ||
        !('amount' in value) ||
        typeof value.amount !== 'string'
      )
        throw new BadRequestException('Expected amount');
      const amount = Number(value.amount);
      if (
        !Number.isInteger(amount) ||
        amount < 1 ||
        amount > 5 ||
        Object.keys(value).length !== 1
      )
        throw new BadRequestException('Invalid amount');
      return { amount: amount * 2 };
    }
  }
  @Injectable()
  class ActionInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler<unknown>) {
      const request = context.switchToHttp().getRequest<HostRequest>();
      request.trace.push('interceptor:before');
      return next
        .handle()
        .pipe(tap(() => request.trace.push('interceptor:after')));
    }
  }
  class ActionFailure extends Error {}
  @Catch(ActionFailure)
  class ActionFilter implements ExceptionFilter {
    constructor(
      @Inject(HttpAdapterHost) private readonly adapter: HttpAdapterHost,
    ) {}
    catch(_error: ActionFailure, host: ArgumentsHost): void {
      this.adapter.httpAdapter.reply(
        host.switchToHttp().getResponse<unknown>(),
        { code: 'HOST_ACTION_FILTER' },
        418,
      );
    }
  }
  @Module({
    providers: [
      RequestInfo,
      ComponentGuard,
      MethodGuard,
      MethodPipe,
      ActionInterceptor,
      ActionFilter,
    ],
    exports: [
      RequestInfo,
      ComponentGuard,
      MethodGuard,
      MethodPipe,
      ActionInterceptor,
      ActionFilter,
    ],
  })
  class HostServices {}

  @UseGuards(ComponentGuard)
  @SetMetadata('test:class-role', 'member')
  class ComponentBase {
    @State({ writable: true }) items: string[] = [];
    @State() details = { visits: 0 };
    @Action() append() {
      this.items.push('server');
      this.details.visits++;
    }
  }
  @LiveComponent({ name: 'counter', view: 'counter' })
  class Counter extends ComponentBase {
    @State() count = 0;
    @State({ writable: true }) label = 'initial';
    @Locked() protectedValue = 'server-owned';
    @State() scopeId = '';
    constructor(@Inject(RequestInfo) private readonly info: RequestInfo) {
      super();
    }
    @Computed() get doubled() {
      return this.count * 2;
    }
    mount() {
      this.scopeId = this.info.id;
    }
    @Action()
    @UseGuards(MethodGuard)
    @SetMetadata('test:method-role', 'editor')
    @UseInterceptors(ActionInterceptor)
    @UsePipes(MethodPipe)
    increment(@ActionInput() input: { amount: number }) {
      this.info.request.trace.push('action');
      traces.push(this.info.request.trace);
      this.count += input.amount;
      this.scopeId = this.info.id;
    }
    @Action() refresh() {
      this.scopeId = this.info.id;
    }
    @Action() assign(@ActionInput(MethodPipe) input: { amount: number }) {
      this.count = input.amount;
    }
    @Action()
    @UseFilters(ActionFilter)
    fail() {
      throw new ActionFailure('private exception detail');
    }
    hidden() {
      throw new Error('Must never be callable');
    }
  }
  @Controller()
  class HostController {
    constructor(@Inject(LiveRuntime) private readonly runtime: LiveRuntime) {}
    @Get('mount')
    async mount(@Req() request: HostRequest) {
      return { html: (await this.runtime.mount(Counter, request)).value };
    }
    @Get('api/health') health() {
      return { ok: true };
    }
  }
  @Module({
    imports: [
      LiveModule.register({
        components: [Counter],
        imports: [HostServices],
        renderer: engine,
        origin,
        basePath,
        resolveIdentity: (request) => {
          const key: unknown = Reflect.get(
            Reflect.get(request, 'headers'),
            'x-session',
          );
          const identity =
            typeof key === 'string' ? sessions.get(key) : undefined;
          if (!identity) throw new ForbiddenException('Unknown host session');
          return identity;
        },
        authorize: (identity, _component, action) =>
          action === '$mount' || !identity.binding.includes('denied'),
        maxRequestsPerMinute: 1000,
      }),
    ],
    controllers: [HostController],
    providers: [{ provide: APP_GUARD, useClass: GlobalGuard }],
  })
  class HostModule {}
  const compiled = await Test.createTestingModule({
    imports: [HostModule],
  }).compile();
  const app =
    platform === 'fastify'
      ? compiled.createNestApplication(new FastifyAdapter(), { logger: false })
      : compiled.createNestApplication({ logger: false });
  resources.push({ app, root, engine });
  if (basePath) app.setGlobalPrefix(basePath.slice(1));
  await app.listen(0, '127.0.0.1');
  const base = `${await app.getUrl()}${basePath}`;
  async function mount(session = 'alice'): Promise<Mount> {
    const response = await fetch(`${base}/mount`, {
      headers: { 'x-session': session },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { html: string };
    const snapshot = /data-nv-snapshot="([^"]+)"/.exec(body.html)?.[1];
    if (!snapshot) throw new Error(`Missing initial snapshot: ${body.html}`);
    return { snapshot, revision: 0, html: body.html };
  }
  async function post(
    mounted: Pick<Mount, 'snapshot' | 'revision'>,
    action = 'increment',
    overrides: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    return fetch(`${base}/_nestvexa/live/counter/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        'x-session': 'alice',
        'x-nestvexa-csrf': csrf,
        ...headers,
      },
      body: JSON.stringify({
        protocol: 'nestvexa-live/1',
        requestId: randomUUID(),
        snapshot: mounted.snapshot,
        revision: mounted.revision,
        updates: {},
        input: action === 'increment' ? { amount: '2' } : null,
        ...overrides,
      }),
    });
  }
  return {
    app,
    base,
    mount,
    post,
    traces,
    scopeIds,
    runtime: app.get(LiveRuntime),
  };
}

describe.each(['express', 'fastify'] as const)(
  'Live native Nest pipeline: %s',
  (platform) => {
    it('uses imported scoped DI, class/method metadata, guards, pipes and interceptors through real Nest HTTP', async () => {
      const host = await fixture(platform);
      const mounted = await host.mount();
      expect(mounted.html).toContain('<output>0</output>');
      expect(mounted.html).not.toContain('server-provider-secret');
      const response = await host.post(mounted);
      expect(response.status).toBe(201);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const result = (await response.json()) as Reply;
      expect(result.state['count']).toBe(4);
      expect(result.html).toContain('<b>8</b>');
      expect(result.state).not.toHaveProperty('info');
      expect(JSON.stringify(result)).not.toContain('server-provider-secret');
      expect(result.state['scopeId']).toBe(host.scopeIds.at(-1));
      expect(host.traces[0]).toEqual([
        'global',
        'class',
        'method',
        'interceptor:before',
        'action',
        'interceptor:after',
      ]);
      const next = await host.post({ snapshot: result.snapshot, revision: 1 });
      expect(next.status).toBe(201);
      const updated = (await next.json()) as Reply;
      expect(updated.state['count']).toBe(8);
      expect(updated.state['scopeId']).not.toBe(result.state['scopeId']);
      expect(
        await fetch(`${host.base}/api/health`).then((response) =>
          response.json(),
        ),
      ).toEqual({ ok: true });
    });

    it('rejects cross-session snapshots, CSRF/origin bypass, guessed methods, locked writes and forged state', async () => {
      const host = await fixture(platform);
      const mounted = await host.mount();
      for (const headers of [
        { 'x-nestvexa-csrf': 'wrong' },
        { origin: 'https://attacker.invalid' },
        { 'x-deny-global': '1' },
        { 'x-deny-class': '1' },
        { 'x-deny-method': '1' },
      ]) {
        expect(
          (await host.post(mounted, 'increment', {}, headers)).status,
        ).toBe(403);
      }
      expect(
        (await host.post(mounted, 'increment', {}, { 'x-session': 'bob' }))
          .status,
      ).toBe(410);
      expect((await host.post(mounted, 'hidden')).status).toBe(404);
      expect(
        (
          await host.post(mounted, 'refresh', {
            updates: { protectedValue: 'forged' },
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await host.post(mounted, 'refresh', {
            updates: { info: { secret: 'forged' } },
          })
        ).status,
      ).toBe(422);
      expect(
        (await host.post(mounted, 'increment', { input: { amount: 'bad' } }))
          .status,
      ).toBe(400);
      const accepted = await host.post(mounted);
      expect(accepted.status).toBe(201);
      expect((await host.post(mounted)).status).toBe(409);
      const another = await host.mount();
      expect(
        (await host.post(another, 'refresh', { updates: { label: 123 } }))
          .status,
      ).toBe(422);
      const forbidden = await host.mount('denied');
      expect(
        (await host.post(forbidden, 'increment', {}, { 'x-session': 'denied' }))
          .status,
      ).toBe(403);
      const bob = await host.mount('bob');
      const result = await host.post(
        bob,
        'increment',
        {},
        { 'x-session': 'bob' },
      );
      expect(result.status).toBe(201);
      expect(((await result.json()) as Reply).state['count']).toBe(4);
    });

    it('executes method exception filters and invalidates uncertain failed actions', async () => {
      const host = await fixture(platform);
      const mounted = await host.mount();
      const failure = await host.post(mounted, 'fail');
      expect(failure.status).toBe(418);
      expect(await failure.json()).toEqual({ code: 'HOST_ACTION_FILTER' });
      expect((await host.post(mounted, 'refresh')).status).toBe(410);
    });

    it('runs parameter pipes and rejects malformed envelopes before invoking actions', async () => {
      const host = await fixture(platform);
      const mounted = await host.mount();
      expect(
        (await host.post(mounted, 'assign', { input: { amount: 'bad' } }))
          .status,
      ).toBe(400);
      expect(
        (await host.post(mounted, 'refresh', { injected: 'unknown field' }))
          .status,
      ).toBe(400);
      expect(
        (await host.post(mounted, 'refresh', { protocol: 'nestvexa-live/99' }))
          .status,
      ).toBe(426);
      expect(
        (await host.post(mounted, 'refresh', { snapshot: 'tampered' })).status,
      ).toBe(400);
      expect(
        (
          await host.post(
            mounted,
            'refresh',
            {},
            { 'content-type': 'text/plain' },
          )
        ).status,
      ).toBe(415);
      const accepted = await host.post(mounted, 'assign', {
        input: { amount: '3' },
      });
      expect(accepted.status).toBe(201);
      expect(((await accepted.json()) as Reply).state['count']).toBe(6);
    });

    it('escapes writable text and invalidates snapshots on host logout', async () => {
      const host = await fixture(platform);
      const mounted = await host.mount();
      const response = await host.post(mounted, 'refresh', {
        updates: { label: '<script>alert(1)</script>' },
      });
      expect(response.status).toBe(201);
      const result = (await response.json()) as Reply;
      expect(result.html).toContain('&lt;script&gt;');
      expect(result.html).not.toContain('<script>');
      memoryStore(host.runtime).revoke(
        'tenant-a/session-alice/principal-alice',
      );
      expect(
        (
          await host.post(
            { snapshot: result.snapshot, revision: result.component.revision },
            'refresh',
          )
        ).status,
      ).toBe(410);
    });

    it('publishes a safe state marker and explicit base path matching the host global prefix', async () => {
      const host = await fixture(platform, '/host/v1');
      const mounted = await host.mount();
      expect(mounted.html).toContain(
        'data-nv-endpoint="/host/v1/_nestvexa/live/counter"',
      );
      const encoded = /data-nv-state="([^"]+)"/.exec(mounted.html)?.[1];
      if (!encoded) throw new Error('Missing initial public state marker');
      const entities: Record<string, string> = {
        '&quot;': '"',
        '&amp;': '&',
        '&lt;': '<',
        '&gt;': '>',
      };
      const initial: unknown = JSON.parse(
        encoded.replace(
          /&(?:quot|amp|lt|gt);/g,
          (entity) => entities[entity] ?? entity,
        ),
      );
      expect(initial).toMatchObject({
        count: 0,
        label: 'initial',
        items: [],
        details: { visits: 0 },
      });
      expect(initial).not.toHaveProperty('info');
      const response = await host.post(mounted);
      expect(response.status).toBe(201);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(((await response.json()) as Reply).state['count']).toBe(4);
    });

    it('restores detached mutable nested state and allows actions to mutate validated client arrays', async () => {
      const host = await fixture(platform);
      const mounted = await host.mount();
      const first = await host.post(mounted, 'append', {
        updates: { items: ['client'] },
      });
      expect(first.status).toBe(201);
      const one = (await first.json()) as Reply;
      expect(one.state['items']).toEqual(['client', 'server']);
      expect(one.state['details']).toEqual({ visits: 1 });
      const second = await host.post(
        { snapshot: one.snapshot, revision: one.component.revision },
        'append',
      );
      expect(second.status).toBe(201);
      const two = (await second.json()) as Reply;
      expect(two.state['items']).toEqual(['client', 'server', 'server']);
      expect(two.state['details']).toEqual({ visits: 2 });
    });
  },
);

describe('Live registration rejects ambiguous or unsafe metadata', () => {
  function options(
    components: Parameters<typeof LiveModule.register>[0]['components'],
  ) {
    return {
      components,
      renderer: new HbsEngine({ root: 'unused-registration-only' }),
      origin,
      resolveIdentity: () => ({
        binding: 'test-host-session',
        csrfToken: csrf,
      }),
      authorize: () => true,
    };
  }
  it.each([
    '/host/',
    '//host',
    '/host//v1',
    '/host/../admin',
    '/host?x=1',
    'https://evil.invalid',
    '/',
    '/host%2fadmin',
  ])('rejects noncanonical public prefix %s', (basePath) => {
    expect(() => LiveModule.register({ ...options([]), basePath })).toThrow(
      'base path',
    );
  });
  it.each([
    'runtime',
    'then',
    'mount',
    'hydrate',
    'dehydrate',
    'onModuleInit',
    'onApplicationShutdown',
    'toString',
    'constructor',
  ])('rejects reserved action member %s', (name) => {
    expect(() => Action()({}, name, { value: () => undefined })).toThrow();
  });
  it('rejects duplicate state/computed and multiple action aliases', () => {
    class Collision {
      get value() {
        return 1;
      }
    }
    LiveComponent({ name: 'collision', view: 'counter' })(Collision);
    State()(Collision.prototype, 'value');
    const getter = Object.getOwnPropertyDescriptor(
      Collision.prototype,
      'value',
    );
    if (!getter) throw new Error('Missing test getter');
    Computed()(Collision.prototype, 'value', getter);
    expect(() => LiveModule.register(options([Collision]))).toThrow(
      'Duplicate live member',
    );
    class Aliases {
      invoke() {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      Aliases.prototype,
      'invoke',
    );
    if (!descriptor) throw new Error('Missing test method');
    Action({ id: 'first' })(Aliases.prototype, 'invoke', descriptor);
    expect(() =>
      Action({ id: 'second' })(Aliases.prototype, 'invoke', descriptor),
    ).toThrow('Multiple action IDs');
  });
  it('requires an override to explicitly opt into exposure again without invoking an overriding getter', () => {
    class Base {
      @Action() invoke() {}
    }
    class Override extends Base {
      override invoke() {}
    }
    LiveComponent({ name: 'override', view: 'counter' })(Override);
    expect(() => LiveModule.register(options([Override]))).toThrow(
      'without @Action',
    );
    let calls = 0;
    class GetterOverride extends Base {}
    Object.defineProperty(GetterOverride.prototype, 'invoke', {
      get() {
        calls++;
        return () => undefined;
      },
    });
    LiveComponent({ name: 'getter-override', view: 'counter' })(GetterOverride);
    expect(() => LiveModule.register(options([GetterOverride]))).toThrow(
      'without @Action',
    );
    expect(calls).toBe(0);
  });
});
