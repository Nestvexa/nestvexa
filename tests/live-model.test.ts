import 'reflect-metadata';
import {
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
  ArgumentsHost,
  CallHandler,
  CanActivate,
  ExceptionFilter,
  ExecutionContext,
  INestApplication,
  NestInterceptor,
} from '@nestjs/common';
import { APP_GUARD, HttpAdapterHost, REQUEST } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tap } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '../packages/live/dist/index.js';

const origin = 'http://localhost:3100';
const csrf = 'host-generated-model-csrf-01234567890123456789';
const resources: {
  app: INestApplication;
  root: string;
  renderer: HbsEngine;
}[] = [];
afterEach(async () => {
  for (const { app, root, renderer } of resources.splice(0)) {
    await app.close();
    await renderer.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
interface Request {
  readonly headers: Record<string, string | undefined>;
  trace: string[];
}
interface Mounted {
  snapshot: string;
  revision: number;
}
interface Reply extends Mounted {
  component: { revision: number };
  state: { label: string; count: number; scopeId: string };
}
function deferred() {
  let resolve: () => void = () => {
    throw new Error('Not initialized');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}
// A local OS-assigned port can appear on fetch's browser-oriented forbidden-port list.
// Use Node HTTP directly while exercising the real Nest server over a TCP socket.
function postJson(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      url,
      { method: 'POST', headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: unknown) => {
          if (Buffer.isBuffer(chunk)) chunks.push(chunk);
          else request.destroy(new Error('Unexpected HTTP response chunk'));
        });
        response.on('error', reject);
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            if (Array.isArray(value))
              for (const item of value) responseHeaders.append(name, item);
            else if (value !== undefined) responseHeaders.append(name, value);
          resolve(
            new Response(Buffer.concat(chunks).toString('utf8'), {
              status: response.statusCode ?? 500,
              headers: responseHeaders,
            }),
          );
        });
      },
    );
    request.on('error', reject);
    request.setTimeout(5_000, () =>
      request.destroy(new Error('Local model HTTP request timed out')),
    );
    request.end(body);
  });
}
async function waitForGate(
  entered: Promise<void>,
  pending: Promise<Response>,
): Promise<void> {
  await Promise.race([
    entered,
    pending.then((response) => {
      throw new Error(
        `Request completed before validation gate (${response.status})`,
      );
    }),
  ]);
}
async function fixture(platform: 'express' | 'fastify') {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-model-'));
  await writeFile(
    join(root, 'editor.hbs'),
    '<output>{{label}}</output><b>{{count}}</b><code>{{scopeId}}</code>',
  );
  const renderer = new HbsEngine({ root });
  await renderer.initialize();
  const traces: string[][] = [];
  const hooks: string[] = [];
  const policies: string[] = [];
  let validationGate: { entered: () => void; wait: Promise<void> } | undefined;
  @Injectable({ scope: Scope.REQUEST })
  class Info {
    readonly id = randomUUID();
    constructor(@Inject(REQUEST) readonly request: Request) {}
  }
  @Injectable()
  class GlobalGuard implements CanActivate {
    canActivate(context: ExecutionContext): boolean {
      const request = context.switchToHttp().getRequest<Request>();
      request.trace ??= [];
      request.trace.push('global');
      if (request.headers['x-deny-global']) throw new ForbiddenException();
      return true;
    }
  }
  class PolicyFailure extends Error {}
  @Injectable()
  class ComponentGuard implements CanActivate {
    constructor(@Inject(Info) private readonly info: Info) {}
    canActivate(): boolean {
      this.info.request.trace.push('class');
      if (this.info.request.headers['x-deny-class']) throw new PolicyFailure();
      return true;
    }
  }
  @Injectable()
  class MethodGuard implements CanActivate {
    canActivate(): boolean {
      throw new Error('Action guard must never run during sync');
    }
  }
  @Injectable()
  class ComponentInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler<unknown>) {
      const request = context.switchToHttp().getRequest<Request>();
      request.trace.push('interceptor:before');
      return next.handle().pipe(
        tap(() => {
          request.trace.push('interceptor:after');
          traces.push([...request.trace]);
        }),
      );
    }
  }
  @Catch(PolicyFailure)
  class ComponentFilter implements ExceptionFilter {
    constructor(
      @Inject(HttpAdapterHost) private readonly adapter: HttpAdapterHost,
    ) {}
    catch(_error: PolicyFailure, host: ArgumentsHost): void {
      this.adapter.httpAdapter.reply(
        host.switchToHttp().getResponse<unknown>(),
        { code: 'CLASS_POLICY' },
        418,
      );
    }
  }
  @Module({
    providers: [
      Info,
      ComponentGuard,
      MethodGuard,
      ComponentInterceptor,
      ComponentFilter,
    ],
    exports: [
      Info,
      ComponentGuard,
      MethodGuard,
      ComponentInterceptor,
      ComponentFilter,
    ],
  })
  class HostServices {}
  @LiveComponent({ name: 'editor', view: 'editor' })
  @UseGuards(ComponentGuard)
  @UseInterceptors(ComponentInterceptor)
  @UseFilters(ComponentFilter)
  class Editor {
    constructor(@Inject(Info) private readonly info: Info) {}
    @State({
      writable: true,
      validate: async (value) => {
        if (value === 'wait' && validationGate) {
          validationGate.entered();
          await validationGate.wait;
        }
        if (value === 'throw')
          throw new Error('Private validator implementation');
        return typeof value === 'string' && value.length <= 8;
      },
    })
    label = 'initial';
    @State() count = 0;
    @State() scopeId = '';
    mount(): void {
      hooks.push('mount');
    }
    hydrate(): void {
      hooks.push('hydrate');
      this.scopeId = this.info.id;
    }
    dehydrate(): void {
      hooks.push('dehydrate');
    }
    beforeAction(): void {
      hooks.push('beforeAction');
    }
    afterAction(): void {
      hooks.push('afterAction');
    }
    @Action()
    @UseGuards(MethodGuard)
    forbidden(): void {
      throw new Error('Sync invoked action');
    }
    @Action() increment(): void {
      this.count++;
    }
  }
  const module = await Test.createTestingModule({
    imports: [
      LiveModule.register({
        origin,
        renderer,
        components: [Editor],
        imports: [HostServices],
        resolveIdentity: (request) => {
          const headers: unknown = Reflect.get(request, 'headers');
          const user: unknown =
            typeof headers === 'object' && headers !== null
              ? Reflect.get(headers, 'x-user')
              : undefined;
          return {
            binding:
              user === 'bob'
                ? 'tenant-b/session-bob/principal-bob'
                : 'tenant-a/session-alice/principal-alice',
            csrfToken: csrf,
          };
        },
        authorize: (_identity, _name, action) => {
          policies.push(action);
          return action !== '$sync' || allowSync;
        },
      }),
    ],
    providers: [{ provide: APP_GUARD, useClass: GlobalGuard }],
  }).compile();
  let allowSync = true;
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  resources.push({ app, root, renderer });
  app.setGlobalPrefix('app');
  await app.listen(0, '127.0.0.1');
  const runtime = app.get(LiveRuntime);
  const mounted = (await runtime.mount(Editor, { headers: {} })).value;
  const snapshot = /data-nv-snapshot="([^"]+)"/.exec(mounted)?.[1];
  if (!snapshot) throw new Error('Missing snapshot');
  hooks.length = 0;
  const initial: Mounted = { snapshot, revision: 0 };
  async function post(
    state: Mounted,
    updates: Record<string, unknown> = {},
    options: {
      action?: string;
      input?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    return postJson(
      `${await app.getUrl()}/app/_nestvexa/live/editor/${options.action ?? '_sync'}`,
      {
        origin,
        'content-type': 'application/json',
        'x-nestvexa-csrf': csrf,
        ...options.headers,
      },
      JSON.stringify({
        protocol: 'nestvexa-live/1',
        requestId: randomUUID(),
        snapshot: state.snapshot,
        revision: state.revision,
        updates,
        input: options.input ?? null,
      }),
    );
  }
  return {
    app,
    runtime,
    initial,
    post,
    traces,
    hooks,
    policies,
    denySync: () => {
      allowSync = false;
    },
    gate: (value: typeof validationGate) => {
      validationGate = value;
    },
  };
}

describe.each(['express', 'fastify'] as const)(
  'Live model synchronization: %s',
  (platform) => {
    it('uses global/class Nest pipeline and request DI without invoking action guards or hooks', async () => {
      const host = await fixture(platform);
      const first = await host.post(host.initial, { label: '<b>' });
      expect(first.status).toBe(201);
      expect(first.headers.get('cache-control')).toBe('no-store');
      const result = (await first.json()) as Reply & { html: string };
      expect(result.state).toMatchObject({ label: '<b>', count: 0 });
      expect(result.component.revision).toBe(1);
      expect(result.html).toContain('&lt;b&gt;');
      expect(host.hooks).toEqual(['hydrate', 'dehydrate']);
      expect(host.traces).toEqual([
        ['global', 'class', 'interceptor:before', 'interceptor:after'],
      ]);
      expect(host.policies).toEqual(['$mount', '$sync']);
      expect(result.state.scopeId).toMatch(/^[0-9a-f-]{36}$/);
      const secondState = { snapshot: result.snapshot, revision: 1 };
      const second = await host.post(secondState, { label: 'second' });
      const next = (await second.json()) as Reply;
      expect(next.state.scopeId).not.toBe(result.state.scopeId);
      expect(
        await host.post(host.initial).then((response) => response.status),
      ).toBe(409);
    });

    it('requires explicit sync policy and preserves global/class denial and class filters', async () => {
      const host = await fixture(platform);
      expect(
        (
          await host.post(
            host.initial,
            {},
            { headers: { 'x-deny-global': '1' } },
          )
        ).status,
      ).toBe(403);
      const classDenied = await host.post(
        host.initial,
        {},
        { headers: { 'x-deny-class': '1' } },
      );
      expect(classDenied.status).toBe(418);
      expect(await classDenied.json()).toEqual({ code: 'CLASS_POLICY' });
      host.denySync();
      expect((await host.post(host.initial, { label: 'change' })).status).toBe(
        403,
      );
      expect(host.runtime.store.size).toBe(1);
      expect(host.hooks).toEqual([]);
    });

    it('rejects malformed writes before hooks and keeps the same token usable after validation errors', async () => {
      const host = await fixture(platform);
      for (const [updates, code] of [
        [{ label: 'over-eight-characters' }, 'STATE_INVALID'],
        [{ label: 42 }, 'STATE_TYPE'],
        [{ count: 42 }, 'STATE_LOCKED'],
        [{ unknown: 'value' }, 'STATE_LOCKED'],
      ] as const) {
        const response = await host.post(host.initial, updates);
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code });
        expect(host.runtime.store.size).toBe(1);
        expect(host.hooks).toEqual([]);
      }
      expect((await host.post(host.initial, { label: 'valid' })).status).toBe(
        201,
      );
    });

    it('applies recoverable validation to ordinary actions before their effects', async () => {
      const host = await fixture(platform);
      expect(
        (await host.post(host.initial, { label: 1 }, { action: 'increment' }))
          .status,
      ).toBe(422);
      expect(host.hooks).toEqual([]);
      const response = await host.post(
        host.initial,
        { label: 'valid' },
        { action: 'increment' },
      );
      expect(response.status).toBe(201);
      expect(((await response.json()) as Reply).state.count).toBe(1);
      expect(host.hooks).toEqual([
        'hydrate',
        'beforeAction',
        'afterAction',
        'dehydrate',
      ]);
    });

    it('protects sync with origin, CSRF, owner binding and an input-free contract', async () => {
      const host = await fixture(platform);
      expect(
        (
          await host.post(
            host.initial,
            {},
            { headers: { origin: 'https://attacker.invalid' } },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await host.post(
            host.initial,
            {},
            { headers: { 'x-nestvexa-csrf': 'wrong' } },
          )
        ).status,
      ).toBe(403);
      expect(
        (await host.post(host.initial, {}, { headers: { 'x-user': 'bob' } }))
          .status,
      ).toBe(410);
      expect(
        (await host.post(host.initial, {}, { input: { method: 'increment' } }))
          .status,
      ).toBe(400);
      expect(
        (await host.post(host.initial, {}, { action: 'not-registered' }))
          .status,
      ).toBe(404);
      expect(host.hooks).toEqual([]);
      expect((await host.post(host.initial, { label: 'valid' })).status).toBe(
        201,
      );
    });

    it('rechecks revision after async validation and never runs the losing request hooks', async () => {
      const host = await fixture(platform);
      const entered = deferred();
      const release = deferred();
      host.gate({ entered: entered.resolve, wait: release.promise });
      const waiting = host.post(host.initial, { label: 'wait' });
      try {
        await waitForGate(entered.promise, waiting);
        const winner = await host.post(host.initial, { label: 'winner' });
        expect(winner.status).toBe(201);
        release.resolve();
        expect((await waiting).status).toBe(409);
        expect(host.hooks).toEqual(['hydrate', 'dehydrate']);
        expect(host.runtime.store.size).toBe(1);
      } finally {
        release.resolve();
        await waiting.catch(() => undefined);
      }
    });

    it('retains state on validator exceptions and hides implementation details', async () => {
      const host = await fixture(platform);
      const failed = await host.post(host.initial, { label: 'throw' });
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain('Private validator');
      expect(host.hooks).toEqual([]);
      expect((await host.post(host.initial, { label: 'valid' })).status).toBe(
        201,
      );
    });

    it('rejects shutdown while awaiting validation before any component hook runs', async () => {
      const host = await fixture(platform);
      const entered = deferred();
      const release = deferred();
      host.gate({ entered: entered.resolve, wait: release.promise });
      const waiting = host.post(host.initial, { label: 'wait' });
      try {
        await waitForGate(entered.promise, waiting);
        host.runtime.onApplicationShutdown();
        release.resolve();
        expect((await waiting).status).toBe(503);
        expect(host.hooks).toEqual([]);
        expect(host.runtime.store.size).toBe(0);
      } finally {
        release.resolve();
        await waiting.catch(() => undefined);
      }
    });

    it('rejects state validation declarations that cannot execute for browser writes', () => {
      expect(() => State({ validate: () => true })).toThrow('writable:true');
      expect(() => State({ writable: false, validate: () => true })).toThrow(
        'writable:true',
      );
      expect(() =>
        Reflect.apply(State, undefined, [
          { writable: true, validate: 'not-a-function' },
        ]),
      ).toThrow('must be a function');
    });
  },
);
