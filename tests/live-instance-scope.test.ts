import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  Controller,
  Get,
  HttpException,
  Inject,
  Injectable,
  Module,
  Req,
  Scope,
  UseGuards,
} from '@nestjs/common';
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  Computed,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '../packages/live/dist/index.js';

const csrf = 'instance-scope-host-csrf-01234567890123456789';
const origin = 'http://localhost';
const resources: { app?: INestApplication; engine: HbsEngine; root: string }[] =
  [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app?.close();
    await resource.engine.dispose();
    if (!resolve(resource.root).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected instance-scope fixture directory');
    await rm(resource.root, { recursive: true, force: true });
  }
});
interface HostRequest {
  headers: Record<string, string | undefined>;
}
interface Reply {
  html: string;
  snapshot: string;
  state: { count: number; owner: string };
  component: { revision: number };
}
async function fixture(platform: 'express' | 'fastify') {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-instance-scope-'));
  await writeFile(
    join(root, 'counter.hbs'),
    '<output>{{count}}</output><span>{{owner}}</span><i>{{instanceMarker}}</i><code>{{requestMarker}}</code><b>{{transientMarker}}</b>',
  );
  const engine = new HbsEngine({ root });
  await engine.initialize();
  const records: {
    phase: string;
    instance: string;
    request: object;
    shared: string;
    transient: string;
    owner: string;
  }[] = [];
  const disposed: string[] = [];
  const guards: { phase: string; shared: string; request: object }[] = [];
  @Injectable({ scope: Scope.REQUEST })
  class RequestInfo {
    readonly id = randomUUID();
    readonly secret = 'private-service-sentinel';
    readonly owner: string;
    constructor(@Inject(REQUEST) readonly request: HostRequest) {
      this.owner = request.headers.cookie === 'session=bob' ? 'bob' : 'alice';
    }
  }
  @Injectable({ scope: Scope.TRANSIENT })
  class TransientInfo {
    readonly id = randomUUID();
    constructor(@Inject(RequestInfo) readonly shared: RequestInfo) {}
  }
  @Injectable()
  class ClassGuard implements CanActivate {
    constructor(@Inject(RequestInfo) private readonly shared: RequestInfo) {}
    canActivate(context: ExecutionContext) {
      const request = context.switchToHttp().getRequest<HostRequest>();
      expect(request).toBe(this.shared.request);
      guards.push({ phase: 'class', shared: this.shared.id, request });
      return request.headers['x-block-class'] !== 'yes';
    }
  }
  @Injectable()
  class MethodGuard implements CanActivate {
    constructor(@Inject(RequestInfo) private readonly shared: RequestInfo) {}
    canActivate(context: ExecutionContext) {
      const request = context.switchToHttp().getRequest<HostRequest>();
      expect(request).toBe(this.shared.request);
      guards.push({ phase: 'method', shared: this.shared.id, request });
      return request.headers['x-block-method'] !== 'yes';
    }
  }
  @Module({
    providers: [RequestInfo, TransientInfo, ClassGuard, MethodGuard],
    exports: [RequestInfo, TransientInfo, ClassGuard, MethodGuard],
  })
  class Services {}
  @LiveComponent({ name: 'scoped-counter', view: 'counter' })
  @UseGuards(ClassGuard)
  class Counter {
    private readonly instance = randomUUID();
    @State() count = 0;
    @State() owner = '';
    constructor(
      @Inject(RequestInfo) private readonly shared: RequestInfo,
      @Inject(TransientInfo) private readonly local: TransientInfo,
      @Inject(REQUEST) private readonly request: HostRequest,
    ) {
      expect(request).toBe(shared.request);
      expect(local.shared).toBe(shared);
      this.record('constructor');
      if (request.headers['x-fail-constructor'] === 'yes')
        throw new HttpException({ code: 'COMPONENT_CONSTRUCTION_FAILED' }, 418);
    }
    private record(phase: string) {
      records.push({
        phase,
        instance: this.instance,
        request: this.request,
        shared: this.shared.id,
        transient: this.local.id,
        owner: this.shared.owner,
      });
    }
    async mount() {
      this.record('mount');
      this.count++;
      await Promise.resolve();
      this.owner = this.shared.owner;
    }
    @Computed() get instanceMarker() {
      return this.instance;
    }
    @Computed() get requestMarker() {
      return this.shared.id;
    }
    @Computed() get transientMarker() {
      return this.local.id;
    }
    @Action()
    @UseGuards(MethodGuard)
    increment() {
      this.record('action');
      this.count++;
      this.owner = this.shared.owner;
    }
    dispose() {
      disposed.push(this.instance);
      this.count = 999;
    }
  }
  @Controller()
  class Home {
    constructor(
      @Inject(LiveRuntime) readonly live: LiveRuntime,
      @Inject(RequestInfo) private readonly shared: RequestInfo,
    ) {}
    @Get('mounts')
    @UseGuards(ClassGuard)
    async mounts(@Req() request: object) {
      expect(request).toBe(this.shared.request);
      const concurrent = await Promise.all([
        this.live.mount(Counter, request),
        this.live.mount(Counter, request),
      ]);
      const sequential = await this.live.mount(Counter, request);
      return {
        html: [...concurrent, sequential].map((value) => value.value),
        shared: this.shared.id,
      };
    }
  }
  const module = await Test.createTestingModule({
    imports: [
      Services,
      LiveModule.register({
        components: [Counter],
        imports: [Services],
        renderer: engine,
        origin,
        resolveIdentity(request) {
          const headers: unknown = Reflect.get(request, 'headers');
          const cookie: unknown =
            headers && typeof headers === 'object'
              ? Reflect.get(headers, 'cookie')
              : undefined;
          return {
            binding:
              cookie === 'session=bob'
                ? 'tenant-b/session-bob/principal-bob'
                : 'tenant-a/session-alice/principal-alice',
            csrfToken: csrf,
          };
        },
        authorize: () => true,
      }),
    ],
    controllers: [Home],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  resources.push({ app, engine, root });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  async function mounts(headers: Record<string, string> = {}) {
    const response = await fetch(base + '/mounts', { headers });
    if (!response.ok) return { response, html: [] as string[], shared: '' };
    const body = (await response.json()) as { html: string[]; shared: string };
    return { response, ...body };
  }
  const snapshot = (html: string) =>
    /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '';
  function post(
    token: string,
    revision = 0,
    headers: Record<string, string> = {},
  ) {
    return fetch(base + '/_nestvexa/live/scoped-counter/increment', {
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
        snapshot: token,
        revision,
        updates: {},
        input: null,
      }),
    });
  }
  return {
    mounts,
    post,
    snapshot,
    records,
    disposed,
    guards,
    runtime: app.get(LiveRuntime),
  };
}

describe.each(['express', 'fastify'] as const)(
  'component instance isolation (%s)',
  (platform) => {
    it('creates fresh same-type simultaneous and sequential instances with shared request services', async () => {
      const f = await fixture(platform);
      const mounted = await f.mounts();
      expect(mounted.response.status).toBe(200);
      expect(mounted.html).toHaveLength(3);
      for (const html of mounted.html) {
        expect(html).toContain('<output>1</output><span>alice</span>');
        expect(html).not.toContain('private-service-sentinel');
        const stored = f.runtime.store.peek(
          f.snapshot(html),
          'tenant-a/session-alice/principal-alice',
        );
        expect(stored.state).toEqual({ count: 1, owner: 'alice' });
      }
      const constructors = f.records.filter(
        (record) => record.phase === 'constructor',
      );
      expect(constructors).toHaveLength(3);
      expect(new Set(constructors.map((record) => record.instance)).size).toBe(
        3,
      );
      expect(new Set(constructors.map((record) => record.transient)).size).toBe(
        3,
      );
      expect(new Set(constructors.map((record) => record.shared))).toEqual(
        new Set([mounted.shared]),
      );
      expect(new Set(constructors.map((record) => record.request)).size).toBe(
        1,
      );
      expect(f.disposed).toHaveLength(3);
      expect(new Set(f.disposed)).toEqual(
        new Set(constructors.map((record) => record.instance)),
      );
      expect(f.guards[0]?.shared).toBe(mounted.shared);
      expect(f.guards[0]?.request).toBe(constructors[0]?.request);
    });
    it('keeps sibling snapshots independent and uses fresh instances/dependencies for actions', async () => {
      const f = await fixture(platform);
      const mounted = await f.mounts();
      const first = f.snapshot(mounted.html[0] ?? '');
      const second = f.snapshot(mounted.html[1] ?? '');
      const one = await f.post(first);
      expect(one.status).toBe(201);
      const oneBody = (await one.json()) as Reply;
      expect(oneBody.state).toEqual({ count: 2, owner: 'alice' });
      const two = await f.post(first, 1);
      expect(two.status).toBe(201);
      expect(((await two.json()) as Reply).state.count).toBe(3);
      const sibling = await f.post(second);
      expect(sibling.status).toBe(201);
      expect(((await sibling.json()) as Reply).state.count).toBe(2);
      const constructors = f.records.filter(
        (record) => record.phase === 'constructor',
      );
      expect(constructors).toHaveLength(6);
      expect(new Set(constructors.map((record) => record.instance)).size).toBe(
        6,
      );
      expect(new Set(constructors.map((record) => record.transient)).size).toBe(
        6,
      );
      const actions = f.records.filter((record) => record.phase === 'action');
      expect(actions).toHaveLength(3);
      expect(new Set(actions.map((record) => record.shared)).size).toBe(3);
      for (const action of actions) {
        const guards = f.guards.filter(
          (guard) => guard.request === action.request,
        );
        expect(guards.map((guard) => guard.phase)).toEqual(['class', 'method']);
        expect(guards.every((guard) => guard.shared === action.shared)).toBe(
          true,
        );
      }
    });
    it('isolates cookie-authenticated fixture identities and never resolves a forged cross-user snapshot', async () => {
      const f = await fixture(platform);
      const alice = await f.mounts({ cookie: 'session=alice' });
      const bob = await f.mounts({ cookie: 'session=bob' });
      expect(bob.html.every((html) => html.includes('<span>bob</span>'))).toBe(
        true,
      );
      expect(bob.shared).not.toBe(alice.shared);
      const before = f.records.length;
      expect(
        (
          await f.post(f.snapshot(alice.html[0] ?? ''), 0, {
            cookie: 'session=bob',
          })
        ).status,
      ).toBe(410);
      expect(f.records).toHaveLength(before);
      expect(
        (
          await f.post(f.snapshot(bob.html[0] ?? ''), 0, {
            cookie: 'session=bob',
          })
        ).status,
      ).toBe(201);
      const aliceScopes = new Set(
        f.records
          .filter((record) => record.owner === 'alice')
          .map((record) => record.shared),
      );
      expect(
        f.records
          .filter((record) => record.owner === 'bob')
          .every((record) => !aliceScopes.has(record.shared)),
      ).toBe(true);
    });
    it('retains actual class/method guards before construction and allows a safe retry after rejection', async () => {
      const f = await fixture(platform);
      const mounted = await f.mounts();
      const token = f.snapshot(mounted.html[0] ?? '');
      const before = f.records.length;
      expect((await f.post(token, 0, { 'x-block-class': 'yes' })).status).toBe(
        403,
      );
      expect((await f.post(token, 0, { 'x-block-method': 'yes' })).status).toBe(
        403,
      );
      expect(f.records).toHaveLength(before);
      expect((await f.post(token)).status).toBe(201);
    });
    it('does not create an unregistered component supplied to the host mount API', async () => {
      const f = await fixture(platform);
      let constructed = false;
      @LiveComponent({ name: 'unregistered-scope', view: 'counter' })
      class Unregistered {
        constructor() {
          constructed = true;
        }
      }
      await expect(f.runtime.mount(Unregistered, {})).rejects.toThrow(
        'not registered',
      );
      expect(constructed).toBe(false);
      expect(f.records).toEqual([]);
    });
    it('propagates constructor failures without exposing or retaining partial component instances', async () => {
      const f = await fixture(platform);
      const failed = await f.mounts({ 'x-fail-constructor': 'yes' });
      expect(failed.response.status).toBe(418);
      expect(f.runtime.store.size).toBe(0);
      expect(f.disposed).toEqual([]);
      const mounted = await f.mounts();
      const token = f.snapshot(mounted.html[0] ?? '');
      const failure = await f.post(token, 0, { 'x-fail-constructor': 'yes' });
      expect(failure.status).toBe(418);
      expect(((await failure.json()) as { code: string }).code).toBe(
        'COMPONENT_CONSTRUCTION_FAILED',
      );
      expect((await f.post(token)).status).toBe(410);
      expect(f.disposed).toHaveLength(3);
      expect((await f.mounts()).response.status).toBe(200);
    });
  },
);

it('does not make an unexported sibling-module service visible to registered components', async () => {
  @Injectable()
  class HiddenService {}
  @Module({ providers: [HiddenService] })
  class HiddenModule {}
  @LiveComponent({ name: 'hidden-dependent', view: 'unused' })
  class HiddenDependent {
    constructor(@Inject(HiddenService) readonly hidden: HiddenService) {}
  }
  const renderer = new HbsEngine({ root: process.cwd() });
  await expect(
    Test.createTestingModule({
      imports: [
        HiddenModule,
        LiveModule.register({
          components: [HiddenDependent],
          renderer,
          origin,
          resolveIdentity: () => ({
            binding: 'host-identity-session-bound',
            csrfToken: csrf,
          }),
          authorize: () => true,
        }),
      ],
    }).compile(),
  ).rejects.toThrow(/HiddenService|resolve dependencies/);
});
