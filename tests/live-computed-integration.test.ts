import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
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
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  Computed,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '../packages/live/dist/index.js';

const origin = 'http://localhost:3100';
const csrf = 'computed-test-host-csrf-01234567890123456789';
const resources: { app: INestApplication; engine: HbsEngine; root: string }[] =
  [];
it('rejects ineffective computed method guards during actual Live module registration', () => {
  @LiveComponent({ name: 'guarded-derived', view: 'unused' })
  class Wrong {
    @Computed({ async: true })
    @UseGuards({ canActivate: () => false })
    async summary() {
      return 'must not render';
    }
  }
  expect(() =>
    LiveModule.register({
      components: [Wrong],
      renderer: new HbsEngine({ root: process.cwd() }),
      origin,
      resolveIdentity: () => ({
        binding: 'fixture-identity-bound',
        csrfToken: csrf,
      }),
      authorize: () => true,
    }),
  ).toThrow('cannot use Nest');
});
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    await resource.engine.dispose();
    if (!resolve(resource.root).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected computed fixture directory');
    await rm(resource.root, { recursive: true, force: true });
  }
});
function gate() {
  let resolve: () => void = () => {
    throw new Error('Missing gate');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}
interface HostRequest {
  headers: Record<string, string | undefined>;
}
interface Reply {
  html: string;
  snapshot: string;
  state: Record<string, unknown>;
  component: { revision: number };
}
async function jsonRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  data?: object,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (value: unknown) => {
        if (Buffer.isBuffer(value)) chunks.push(value);
        else request.destroy(new Error('Invalid HTTP fixture bytes'));
      });
      response.on('error', reject);
      response.on('end', () =>
        resolve(
          new Response(Buffer.concat(chunks).toString('utf8'), {
            status: response.statusCode ?? 500,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      );
    });
    request.on('error', reject);
    request.setTimeout(5000, () =>
      request.destroy(new Error('Computed HTTP fixture deadline')),
    );
    request.end(data === undefined ? undefined : JSON.stringify(data));
  });
}
async function fixture(platform: 'express' | 'fastify') {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-computed-'));
  await writeFile(
    join(root, 'derived.hbs'),
    '<output>{{total}}</output><p>{{summary.owner}}:{{summary.count}}</p><span>{{summary.label}}</span>',
  );
  const engine = new HbsEngine({ root });
  await engine.initialize();
  const entered = gate();
  const release = gate();
  const reads: {
    scope: string;
    owner: string;
    stage: string;
    count: number;
  }[] = [];
  const actions: string[] = [];
  @Injectable({ scope: Scope.REQUEST })
  class Context {
    readonly scope = randomUUID();
    stage = 'boot';
    constructor(@Inject(REQUEST) readonly request: HostRequest) {}
    async read(count: number) {
      const owner = this.request.headers['x-user'] ?? 'alice';
      reads.push({ scope: this.scope, owner, stage: this.stage, count });
      if (this.stage === 'render') {
        if (this.request.headers['x-mode'] === 'error')
          throw new Error('private-computed-failure');
        if (this.request.headers['x-mode'] === 'wait') {
          entered.resolve();
          await release.promise;
        }
        if (this.request.headers['x-mode'] === 'timeout')
          await new Promise<void>(() => {});
      }
      return { owner, count, label: '<img src=x onerror=alert(1)>' };
    }
  }
  @Module({ providers: [Context], exports: [Context] })
  class Services {}
  @Injectable()
  class Guard implements CanActivate {
    canActivate(context: ExecutionContext) {
      return (
        context.switchToHttp().getRequest<HostRequest>().headers['x-block'] !==
        'yes'
      );
    }
  }
  @LiveComponent({ name: 'derived', view: 'derived' })
  @UseGuards(Guard)
  class Derived {
    constructor(@Inject(Context) private readonly context: Context) {}
    @State({
      writable: true,
      validate: (value) =>
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 10,
    })
    count = 1;
    @Computed({ dependencies: ['count'] }) get total() {
      return this.count * 2;
    }
    @Computed({ async: true, dependencies: ['count'], timeoutMs: 500 })
    async summary() {
      return this.context.read(this.count);
    }
    async boot() {
      this.context.stage = 'boot';
      await this.summary();
      await this.summary();
    }
    async hydrate() {
      this.context.stage = 'hydrate';
      await this.summary();
      await this.summary();
    }
    async beforeAction() {
      this.context.stage = 'beforeAction';
      await this.summary();
      await this.summary();
    }
    async afterAction() {
      this.context.stage = 'afterAction';
      await this.summary();
      await this.summary();
    }
    async dehydrate() {
      this.context.stage = 'dehydrate';
      await this.summary();
      await this.summary();
      this.context.stage = 'render';
    }
    @Action() async increment() {
      actions.push(this.context.request.headers['x-user'] ?? 'alice');
      this.context.stage = 'action';
      await this.summary();
      await this.summary();
      this.count++;
      await this.summary();
      await this.summary();
    }
  }
  @Controller()
  class Host {
    constructor(@Inject(LiveRuntime) readonly live: LiveRuntime) {}
    @Get('mount') async mount(@Req() request: object) {
      return { html: (await this.live.mount(Derived, request)).value };
    }
    @Get('api/health') health() {
      return { ok: true };
    }
  }
  const module = await Test.createTestingModule({
    imports: [
      LiveModule.register({
        components: [Derived],
        imports: [Services],
        renderer: engine,
        origin,
        resolveIdentity: (request) => {
          const headers: unknown = Reflect.get(request, 'headers');
          const owner: unknown =
            headers && typeof headers === 'object'
              ? Reflect.get(headers, 'x-user')
              : undefined;
          return {
            binding:
              'tenant/session/' + (typeof owner === 'string' ? owner : 'alice'),
            csrfToken: csrf,
          };
        },
        authorize: (identity, _component, action) =>
          !identity.binding.endsWith('/denied') &&
          ['$mount', '$sync', 'increment'].includes(action),
      }),
    ],
    controllers: [Host],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  resources.push({ app, engine, root });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  async function mount(user = 'alice', headers = {}) {
    const response = await jsonRequest(base + '/mount', 'GET', {
      'x-user': user,
      ...headers,
    });
    const json = (await response.json()) as { html?: string };
    return {
      response,
      html: json.html ?? '',
      snapshot: /data-nv-snapshot="([^"]+)"/.exec(json.html ?? '')?.[1] ?? '',
    };
  }
  function post(
    snapshot: string,
    revision: number,
    options: {
      user?: string;
      headers?: Record<string, string>;
      updates?: object;
      action?: string;
    } = {},
  ) {
    return jsonRequest(
      base + '/_nestvexa/live/derived/' + (options.action ?? 'increment'),
      'POST',
      {
        origin,
        'content-type': 'application/json',
        'x-nestvexa-csrf': csrf,
        'x-user': options.user ?? 'alice',
        ...options.headers,
      },
      {
        protocol: 'nestvexa-live/1',
        requestId: randomUUID(),
        snapshot,
        revision,
        updates: options.updates ?? {},
        input: null,
      },
    );
  }
  return { app, mount, post, reads, actions, entered, release, base };
}

for (const platform of ['express', 'fastify'] as const)
  describe('computed real Nest requests: ' + platform, () => {
    it('awaits initial derived values, escapes output and leaves native APIs available', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount();
      expect(mounted.response.status).toBe(200);
      expect(mounted.html).toContain('<output>2</output><p>alice:1</p>');
      expect(mounted.html).toContain(
        '&lt;img src&#x3D;x onerror&#x3D;alert(1)&gt;',
      );
      expect(mounted.html).not.toContain('&quot;summary&quot;');
      expect(f.reads.map((entry) => entry.stage)).toEqual([
        'boot',
        'dehydrate',
        'render',
      ]);
      expect(new Set(f.reads.map((entry) => entry.scope)).size).toBe(1);
      expect(
        (await jsonRequest(f.base + '/api/health', 'GET', {})).status,
      ).toBe(200);
    });
    it('memoizes within stages and invalidates for hooks, state mutation and the next request', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount();
      f.reads.length = 0;
      const response = await f.post(mounted.snapshot, 0);
      expect(response.status).toBe(201);
      const result = (await response.json()) as Reply;
      expect(result.html).toContain('<output>4</output><p>alice:2</p>');
      expect(result.state).toEqual({ count: 2 });
      expect(f.reads.map((entry) => entry.stage)).toEqual([
        'boot',
        'hydrate',
        'beforeAction',
        'action',
        'action',
        'afterAction',
        'dehydrate',
        'render',
      ]);
      expect(
        f.reads
          .filter((entry) => entry.stage === 'action')
          .map((entry) => entry.count),
      ).toEqual([1, 2]);
      const firstScope = f.reads[0]?.scope;
      f.reads.length = 0;
      expect((await f.post(result.snapshot, 1)).status).toBe(201);
      expect(f.reads[0]?.scope).not.toBe(firstScope);
    });
    it('recomputes synchronization without invoking action hooks or methods', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount();
      f.reads.length = 0;
      const response = await f.post(mounted.snapshot, 0, {
        action: '_sync',
        updates: { count: 5 },
      });
      expect(response.status).toBe(201);
      expect(((await response.json()) as Reply).html).toContain(
        '<output>10</output><p>alice:5</p>',
      );
      expect(f.actions).toEqual([]);
      expect(f.reads.map((entry) => entry.stage)).toEqual([
        'boot',
        'hydrate',
        'dehydrate',
        'render',
      ]);
    });
    it('isolates concurrent identities and rejects a swapped snapshot before computed work', async () => {
      const f = await fixture(platform);
      const [alice, bob] = await Promise.all([f.mount(), f.mount('bob')]);
      f.reads.length = 0;
      const responses = await Promise.all([
        f.post(alice.snapshot, 0),
        f.post(bob.snapshot, 0, { user: 'bob' }),
      ]);
      const results = await Promise.all(
        responses.map(async (response) => {
          expect(response.status).toBe(201);
          return (await response.json()) as Reply;
        }),
      );
      expect(results[0]?.html).toContain('alice:2');
      expect(results[1]?.html).toContain('bob:2');
      expect(new Set(f.reads.map((entry) => entry.scope)).size).toBe(2);
      f.reads.length = 0;
      expect(
        (await f.post(results[0]?.snapshot ?? '', 1, { user: 'bob' })).status,
      ).toBe(410);
      expect(f.reads).toEqual([]);
    });
    it('does not expose computed methods as actions or writable fields', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount();
      f.reads.length = 0;
      expect(
        (await f.post(mounted.snapshot, 0, { action: 'summary' })).status,
      ).toBe(404);
      expect(
        (await f.post(mounted.snapshot, 0, { updates: { summary: 'forged' } }))
          .status,
      ).toBe(422);
      expect(
        (await f.post(mounted.snapshot, 0, { updates: { total: 99 } })).status,
      ).toBe(422);
      expect(f.reads).toEqual([]);
      expect((await f.post(mounted.snapshot, 0)).status).toBe(201);
    });
    it('rejects guards, CSRF and invalid state before derived evaluation', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount();
      f.reads.length = 0;
      expect(
        (await f.post(mounted.snapshot, 0, { headers: { 'x-block': 'yes' } }))
          .status,
      ).toBe(403);
      expect(
        (
          await f.post(mounted.snapshot, 0, {
            headers: { 'x-nestvexa-csrf': 'wrong' },
          })
        ).status,
      ).toBe(403);
      expect(
        (await f.post(mounted.snapshot, 0, { updates: { count: 100 } })).status,
      ).toBe(422);
      expect(f.reads).toEqual([]);
      expect((await f.mount('denied')).response.status).toBe(403);
      expect(f.reads).toEqual([]);
    });
    it('redacts computed failures and revokes a token after an action already executed', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount();
      const response = await f.post(mounted.snapshot, 0, {
        headers: { 'x-mode': 'error' },
      });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('private-computed-failure');
      expect(f.actions).toEqual(['alice']);
      expect((await f.post(mounted.snapshot, 0)).status).toBe(410);
    });
    it('bounds never-settling render work and revokes the consumed token', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount();
      const response = await f.post(mounted.snapshot, 0, {
        headers: { 'x-mode': 'timeout' },
      });
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ code: 'COMPUTED_TIMEOUT' });
      expect((await f.post(mounted.snapshot, 0)).status).toBe(410);
    });
    it('rejects late computed resumption after runtime shutdown', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount();
      const pending = f.post(mounted.snapshot, 0, {
        headers: { 'x-mode': 'wait' },
      });
      try {
        await Promise.race([
          f.entered.promise,
          pending.then((response) => {
            throw new Error('Completed before gate: ' + response.status);
          }),
        ]);
        f.app.get(LiveRuntime).onApplicationShutdown();
      } finally {
        f.release.resolve();
      }
      expect((await pending).status).toBe(503);
    });
  });
