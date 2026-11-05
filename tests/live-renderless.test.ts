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
  UsePipes,
} from '@nestjs/common';
import type {
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
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { tap } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryStore } from './support/memory-store.js';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  ActionInput,
  Computed,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  Session,
  State,
  Url,
} from '../packages/live/dist/index.js';
import type { ActionOptions } from '../packages/live/dist/index.js';
import { definition } from '../packages/live/dist/metadata.js';

const origin = 'http://localhost:3100';
const csrf = 'renderless-host-csrf-01234567890123456789';
const binding = 'tenant/session/alice';
const resources: {
  app: INestApplication;
  root: string;
  renderer: HbsEngine;
}[] = [];

afterEach(async () => {
  for (const { app, root, renderer } of resources.splice(0)) {
    await app.close();
    await renderer.dispose();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected renderless fixture directory');
    await rm(root, { recursive: true, force: true });
  }
});

function decorate(options: unknown) {
  return Action(options as ActionOptions)({}, 'save', { value: () => {} });
}

describe('renderless action metadata', () => {
  it.each([
    null,
    [],
    true,
    { renderless: 1 },
    { renderless: 'true' },
    { id: null },
    { id: 4 },
    { unknown: true },
    { [Symbol('renderless')]: true },
    Object.create({ renderless: true }) as object,
  ])('rejects invalid action options %j', (options) => {
    expect(() => decorate(options)).toThrow();
  });

  it.each(['id', 'renderless', 'unknown'])(
    'rejects %s accessors without evaluating them',
    (key) => {
      let reads = 0;
      const options = Object.defineProperty({}, key, {
        get() {
          reads++;
          return true;
        },
      });
      expect(() => decorate(options)).toThrow('own data properties');
      expect(reads).toBe(0);
    },
  );

  it('copies data options at application and preserves inheritance and explicit overrides', () => {
    const options = { id: 'persist', renderless: true };
    const decorator = Action(options);
    @LiveComponent({ name: 'base', view: 'unused' })
    class Base {
      save() {}
      @Action() normal() {}
    }
    const descriptor = Object.getOwnPropertyDescriptor(Base.prototype, 'save');
    if (!descriptor) throw new Error('Missing action descriptor');
    decorator(Base.prototype, 'save', descriptor);
    options.id = 'changed';
    options.renderless = false;
    class Inherited extends Base {}
    class Override extends Base {
      @Action({ id: 'persist', renderless: false }) override save() {}
    }
    class Implicit extends Base {
      override save() {}
    }
    expect(definition(Base).actions.get('persist')).toEqual({
      method: 'save',
      input: false,
      renderless: true,
    });
    expect(definition(Inherited).actions.get('persist')).toEqual(
      definition(Base).actions.get('persist'),
    );
    expect(definition(Override).actions.get('persist')).toEqual({
      method: 'save',
      input: false,
    });
    expect(definition(Base).actions.get('normal')).toEqual({
      method: 'normal',
      input: false,
    });
    expect(() => definition(Implicit)).toThrow('without @Action');
    expect(() =>
      Action({ id: 'other', renderless: true })(
        Base.prototype,
        'save',
        descriptor,
      ),
    ).toThrow('Multiple action IDs');
  });

  it('accepts null-prototype and nonenumerable own data options', () => {
    const options = Object.create(null) as ActionOptions;
    Object.defineProperty(options, 'renderless', { value: true });
    @LiveComponent({ name: 'own-options', view: 'unused' })
    class Own {
      @Action(options) save() {}
    }
    expect(definition(Own).actions.get('save')?.renderless).toBe(true);
  });
});

interface HostRequest {
  readonly headers: Record<string, string | undefined>;
  session: Record<string, unknown>;
}
interface Reference {
  snapshot: string;
  revision: number;
}
interface Reply {
  protocol: string;
  requestId: string;
  snapshot: string;
  component: { revision: number };
  state: { count: number; label: string; visits: number; scopeId: string };
  html: string;
  renderless?: true;
  url?: { key: string; value: string | null; history: string }[];
}
function gate() {
  let release: () => void = () => {
    throw new Error('Missing gate');
  };
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release: () => release() };
}
function postJson(url: string, headers: Record<string, string>, body: object) {
  return new Promise<Response>((resolveResponse, reject) => {
    const request = httpRequest(
      url,
      { method: 'POST', headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: unknown) => {
          if (Buffer.isBuffer(chunk)) chunks.push(chunk);
          else request.destroy(new Error('Invalid renderless HTTP bytes'));
        });
        response.on('error', reject);
        response.on('end', () =>
          resolveResponse(
            new Response(Buffer.concat(chunks).toString('utf8'), {
              status: response.statusCode ?? 500,
            }),
          ),
        );
      },
    );
    request.on('error', reject);
    request.setTimeout(5000, () =>
      request.destroy(new Error('Renderless HTTP fixture deadline')),
    );
    request.end(JSON.stringify(body));
  });
}

async function fixture(platform: 'express' | 'fastify') {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-renderless-'));
  await writeFile(
    join(root, 'editor.hbs'),
    '<b>{{count}}</b>{{summary}}{{asyncSummary}}',
  );
  const renderer = new HbsEngine({ root });
  await renderer.initialize();
  const hooks: string[] = [];
  const trace: { step: string; id: string }[] = [];
  const settings = { throwRender: false, failDispose: false, deny: false };
  const session: Record<string, unknown> = {};
  const entered = gate();
  const release = gate();
  let hold = false;
  let renderCalls = 0;
  const render = renderer.render.bind(renderer);
  renderer.render = (...args) => {
    renderCalls++;
    if (settings.throwRender) throw new Error('Renderer must be skipped');
    return render(...args);
  };
  @Injectable({ scope: Scope.REQUEST })
  class Info {
    readonly id = randomUUID();
    constructor(@Inject(REQUEST) readonly request: HostRequest) {}
    log(step: string): void {
      trace.push({ step, id: this.id });
    }
  }
  @Injectable()
  class GlobalGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<HostRequest>();
      if (request.headers['x-deny-global']) throw new ForbiddenException();
      return true;
    }
  }
  @Injectable()
  class ComponentGuard implements CanActivate {
    constructor(@Inject(Info) private readonly info: Info) {}
    canActivate(): boolean {
      this.info.log('class');
      if (this.info.request.headers['x-deny-class'])
        throw new ForbiddenException();
      return true;
    }
  }
  @Injectable()
  class MethodGuard implements CanActivate {
    constructor(@Inject(Info) private readonly info: Info) {}
    canActivate(): boolean {
      this.info.log('method');
      if (this.info.request.headers['x-deny-method'])
        throw new ForbiddenException();
      return true;
    }
  }
  @Injectable()
  class InputPipe implements PipeTransform {
    constructor(@Inject(Info) private readonly info: Info) {}
    transform(value: unknown): { amount: number } {
      this.info.log('pipe');
      if (
        !value ||
        typeof value !== 'object' ||
        !('amount' in value) ||
        typeof value.amount !== 'string' ||
        !/^[1-5]$/.test(value.amount) ||
        Object.keys(value).length !== 1
      )
        throw new BadRequestException();
      return { amount: Number(value.amount) * 2 };
    }
  }
  @Injectable()
  class Interceptor implements NestInterceptor {
    constructor(@Inject(Info) private readonly info: Info) {}
    intercept(_context: ExecutionContext, next: CallHandler<unknown>) {
      this.info.log('interceptor:before');
      return next.handle().pipe(tap(() => this.info.log('interceptor:after')));
    }
  }
  class ActionFailure extends Error {}
  @Catch(ActionFailure)
  class Filter implements ExceptionFilter {
    constructor(
      @Inject(HttpAdapterHost) private readonly adapter: HttpAdapterHost,
    ) {}
    catch(_error: ActionFailure, host: ArgumentsHost): void {
      this.adapter.httpAdapter.reply(
        host.switchToHttp().getResponse<unknown>(),
        { code: 'ACTION_FILTER' },
        418,
      );
    }
  }
  @Module({
    providers: [
      Info,
      ComponentGuard,
      MethodGuard,
      InputPipe,
      Interceptor,
      Filter,
    ],
    exports: [
      Info,
      ComponentGuard,
      MethodGuard,
      InputPipe,
      Interceptor,
      Filter,
    ],
  })
  class Services {}
  @UseGuards(ComponentGuard)
  class Base {
    constructor(@Inject(Info) protected readonly info: Info) {}
    @State() count = 0;
    @State({
      writable: true,
      validate: (value) => typeof value === 'string' && value.length < 20,
    })
    @Url({ key: 'q', history: 'push', except: '' })
    @Session()
    label = 'initial';
    @Action({ id: 'save', renderless: true })
    @UseGuards(MethodGuard)
    @UseInterceptors(Interceptor)
    @UseFilters(Filter)
    @UsePipes(InputPipe)
    async save(@ActionInput() input: { amount: number }): Promise<void> {
      this.info.log('action');
      if (hold) {
        entered.release();
        await release.promise;
      }
      this.count += input.amount;
      if (this.info.request.headers['x-fail-action']) throw new ActionFailure();
    }
  }
  @LiveComponent({ name: 'editor', view: 'editor' })
  class Editor extends Base {
    @State() visits = 0;
    @State() scopeId = '';
    private secret = 'injected-secret';
    boot(): void {
      hooks.push('boot');
    }
    hydrate(): void {
      hooks.push('hydrate');
      this.scopeId = this.info.id;
    }
    beforeUpdate(): void {
      hooks.push('beforeUpdate');
    }
    afterUpdate(): void {
      hooks.push('afterUpdate');
    }
    beforeAction(): void {
      hooks.push('beforeAction');
    }
    afterAction(): void {
      hooks.push('afterAction');
    }
    dehydrate(): void {
      hooks.push('dehydrate');
      this.visits++;
      this.label = this.label.trim();
    }
    beforeRender(): void {
      hooks.push('beforeRender');
      if (settings.throwRender) throw new Error('Render hook must be skipped');
    }
    afterRender(): void {
      hooks.push('afterRender');
    }
    dispose(): void {
      hooks.push('dispose');
      this.count = 10000;
      this.label = 'disposed';
      if (settings.failDispose) throw new ActionFailure();
    }
    onError(): void {
      hooks.push('onError');
    }
    @Computed() get summary(): number {
      hooks.push('computed');
      if (settings.throwRender) throw new Error('Computed must be skipped');
      return this.count;
    }
    @Computed({ async: true }) async asyncSummary(): Promise<number> {
      hooks.push('computed:async');
      if (settings.throwRender)
        throw new Error('Async computed must be skipped');
      return this.count;
    }
    @Action() normal(): void {
      this.count++;
    }
  }
  const module = await Test.createTestingModule({
    imports: [
      LiveModule.register({
        components: [Editor],
        imports: [Services],
        renderer,
        origin,
        resolveIdentity: (request) => {
          const headers = Reflect.get(
            request,
            'headers',
          ) as HostRequest['headers'];
          // Fixture-only session attachment on the adapter request both platforms expose.
          if (!Reflect.has(request, 'session'))
            Object.defineProperty(request, 'session', { value: session });
          return {
            binding:
              headers['x-user'] === 'bob' ? 'tenant/session/bob' : binding,
            csrfToken: csrf,
          };
        },
        authorize: () => !settings.deny,
      }),
    ],
    providers: [{ provide: APP_GUARD, useClass: GlobalGuard }],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  resources.push({ app, root, renderer });
  app.setGlobalPrefix('app');
  await app.listen(0, '127.0.0.1');
  const runtime = app.get(LiveRuntime);
  async function mount(): Promise<Reference> {
    const html = (
      await runtime.mount(Editor, { headers: {}, session, url: '/editor' })
    ).value;
    const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
    if (!snapshot) throw new Error('Missing renderless snapshot');
    return { snapshot, revision: 0 };
  }
  const initial = await mount();
  hooks.length = 0;
  trace.length = 0;
  const initialRenderCalls = renderCalls;
  async function post(
    reference = initial,
    options: {
      action?: string;
      headers?: Record<string, string>;
      updates?: object;
      input?: unknown;
      body?: object;
      capability?: string | null;
    } = {},
  ) {
    return postJson(
      `${await app.getUrl()}/app/_nestvexa/live/editor/${options.action ?? 'save'}`,
      {
        origin,
        'content-type': 'application/json',
        'x-nestvexa-csrf': csrf,
        ...(options.capability === null
          ? {}
          : {
              'x-nestvexa-capabilities': options.capability ?? 'renderless-v1',
            }),
        ...options.headers,
      },
      {
        protocol: 'nestvexa-live/1',
        requestId: randomUUID(),
        ...reference,
        updates: options.updates ?? {},
        input: options.input === undefined ? { amount: '2' } : options.input,
        ...options.body,
      },
    );
  }
  return {
    app,
    runtime,
    initial,
    post,
    mount,
    hooks,
    trace,
    settings,
    session,
    entered,
    release,
    hold: () => {
      hold = true;
    },
    renders: () => renderCalls - initialRenderCalls,
  };
}

describe.each(['express', 'fastify'] as const)(
  'renderless live actions: %s',
  (platform) => {
    it('uses the real inherited action route and returns post-dehydrate state/url/session without evaluating render work', async () => {
      const f = await fixture(platform);
      f.settings.throwRender = true;
      const response = await f.post(f.initial, {
        updates: { label: ' changed ' },
      });
      expect(response.status).toBe(201);
      const reply = (await response.json()) as Reply;
      expect(reply).toMatchObject({
        protocol: 'nestvexa-live/1',
        snapshot: f.initial.snapshot,
        component: { revision: 1 },
        html: '',
        renderless: true,
        state: { count: 4, label: 'changed', visits: 2 },
        url: [{ key: 'q', value: 'changed', history: 'push' }],
      });
      expect(Object.keys(reply.state).sort()).toEqual([
        'count',
        'label',
        'scopeId',
        'visits',
      ]);
      expect(f.hooks).toEqual([
        'boot',
        'hydrate',
        'beforeUpdate',
        'afterUpdate',
        'beforeAction',
        'afterAction',
        'dehydrate',
        'dispose',
      ]);
      expect(f.renders()).toBe(0);
      expect(f.trace.map(({ step }) => step)).toEqual([
        'class',
        'method',
        'interceptor:before',
        'pipe',
        'action',
        'interceptor:after',
      ]);
      expect(new Set(f.trace.map(({ id }) => id))).toEqual(
        new Set([reply.state.scopeId]),
      );
      expect(Object.values(f.session)).toEqual([
        expect.objectContaining({ value: 'changed' }),
      ]);
      expect(
        memoryStore(f.runtime).peek(reply.snapshot, binding).state,
      ).toEqual(reply.state);
      const second = await f.post({ snapshot: reply.snapshot, revision: 1 });
      const next = (await second.json()) as Reply;
      expect(next.component.revision).toBe(2);
      expect(next.state.scopeId).not.toBe(reply.state.scopeId);
      f.settings.throwRender = false;
      const mounted = await f.mount();
      expect(
        memoryStore(f.runtime).peek(mounted.snapshot, binding).state['label'],
      ).toBe('changed');
    });

    it.each([
      null,
      '',
      'renderless-v2',
      'renderless-v1, other',
      'RENDERLESS-V1',
    ])('falls back to full rendering for capability %s', async (capability) => {
      const f = await fixture(platform);
      const response = await f.post(f.initial, { capability });
      expect(response.status).toBe(201);
      const reply = (await response.json()) as Reply;
      expect(reply).not.toHaveProperty('renderless');
      expect(reply.html).toContain('<b>4</b>');
      expect(f.hooks).toContain('beforeRender');
      expect(f.hooks).toContain('afterRender');
      expect(f.hooks).toContain('computed');
      expect(f.hooks).toContain('computed:async');
      expect(f.renders()).toBe(1);
    });

    it.each(['normal', '_sync'])(
      'renders %s even when support is negotiated',
      async (action) => {
        const f = await fixture(platform);
        const response = await f.post(f.initial, { action, input: null });
        expect(response.status).toBe(201);
        const reply = (await response.json()) as Reply;
        expect(reply).not.toHaveProperty('renderless');
        expect(reply.html).toContain('<b>');
        expect(f.renders()).toBe(1);
      },
    );

    it('keeps admission, global/class/method guards, input validation and host authorization before effects', async () => {
      const f = await fixture(platform);
      for (const headers of [
        { 'x-nestvexa-csrf': 'invalid' },
        { origin: 'http://other.invalid' },
        { 'x-deny-global': 'yes' },
        { 'x-deny-class': 'yes' },
        { 'x-deny-method': 'yes' },
      ])
        expect((await f.post(f.initial, { headers })).status).toBe(403);
      expect(
        (await f.post(f.initial, { headers: { 'x-user': 'bob' } })).status,
      ).toBe(410);
      expect(
        (await f.post(f.initial, { action: 'unknown', input: null })).status,
      ).toBe(404);
      expect(
        (await f.post(f.initial, { input: { amount: 'bad' } })).status,
      ).toBe(400);
      expect((await f.post(f.initial, { updates: { count: 99 } })).status).toBe(
        422,
      );
      expect((await f.post(f.initial, { updates: { label: 1 } })).status).toBe(
        422,
      );
      expect(
        (await f.post(f.initial, { updates: { label: 'x'.repeat(20) } }))
          .status,
      ).toBe(422);
      expect(
        (await f.post(f.initial, { body: { renderless: true } })).status,
      ).toBe(400);
      f.settings.deny = true;
      expect((await f.post()).status).toBe(403);
      expect(f.hooks).toEqual([]);
      expect(f.renders()).toBe(0);
      expect(
        memoryStore(f.runtime).peek(f.initial.snapshot, binding).revision,
      ).toBe(0);
      f.settings.deny = false;
      expect((await f.post()).status).toBe(201);
    });

    it('preserves replay and concurrent action conflicts', async () => {
      const f = await fixture(platform);
      f.hold();
      const pending = f.post();
      await Promise.race([
        f.entered.promise,
        pending.then(() => {
          throw new Error('Action completed before gate');
        }),
      ]);
      try {
        const conflict = await f.post();
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toMatchObject({ code: 'COMPONENT_BUSY' });
      } finally {
        f.release.release();
      }
      expect((await pending).status).toBe(201);
      const replay = await f.post();
      expect(replay.status).toBe(409);
      expect(await replay.json()).toMatchObject({ code: 'STALE_REVISION' });
      expect(f.trace.filter(({ step }) => step === 'action')).toHaveLength(1);
    });

    it.each(['action', 'dispose'])(
      'keeps Nest filters and revokes uncertain %s failures after cleanup',
      async (failure) => {
        const f = await fixture(platform);
        f.settings.failDispose = failure === 'dispose';
        const sessionBefore = structuredClone(f.session);
        const response = await f.post(f.initial, {
          headers: failure === 'action' ? { 'x-fail-action': 'yes' } : {},
        });
        expect(response.status).toBe(418);
        expect(await response.json()).toEqual({ code: 'ACTION_FILTER' });
        expect(f.hooks).toContain('onError');
        expect(f.hooks.filter((hook) => hook === 'dispose')).toHaveLength(1);
        expect(f.session).toEqual(sessionBefore);
        expect((await f.post()).status).toBe(410);
        expect(f.renders()).toBe(0);
      },
    );

    it('revokes advanced state when host session persistence fails', async () => {
      const f = await fixture(platform);
      Object.freeze(f.session);
      const response = await f.post(f.initial, {
        updates: { label: 'changed' },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: 'SESSION_WRITE_FAILED',
      });
      expect(f.hooks.slice(-2)).toEqual(['dispose', 'onError']);
      expect((await f.post()).status).toBe(410);
    });

    it('checks schema before effects and revokes incompatible snapshots', async () => {
      const f = await fixture(platform);
      const incompatible = memoryStore(f.runtime).create('editor', binding, {
        removed: true,
      });
      const response = await f.post({
        snapshot: incompatible.snapshot,
        revision: 0,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'STATE_SCHEMA_CHANGED',
      });
      expect(f.hooks).toEqual(['onError', 'dispose']);
      expect(
        (await f.post({ snapshot: incompatible.snapshot, revision: 0 })).status,
      ).toBe(410);
    });
  },
);
