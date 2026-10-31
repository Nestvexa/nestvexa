import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import {
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Req,
  UseGuards,
} from '@nestjs/common';
import type {
  CanActivate,
  ExecutionContext,
  INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  Session,
  State,
  Url,
} from '../packages/live/dist/index.js';

const origin = 'http://localhost:3100';
const csrf = 'state-context-host-csrf-01234567890123456789';
const resources: { app: INestApplication; engine: HbsEngine; root: string }[] =
  [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    await resource.engine.dispose();
    if (!resolve(resource.root).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected state-context fixture directory');
    await rm(resource.root, { recursive: true, force: true });
  }
});
interface HostRequest {
  headers: Record<string, string | undefined>;
}
interface Reply {
  html: string;
  state: { query: string; page: number; seenOnMount: string };
  snapshot: string;
  component: { revision: number };
  url?: { key: string; value: string | null; history: 'replace' | 'push' }[];
}
function jsonRequest(
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
        else
          request.destroy(
            new Error('Invalid state-context HTTP fixture bytes'),
          );
      });
      response.on('error', reject);
      response.on('end', () =>
        resolve(
          new Response(Buffer.concat(chunks).toString('utf8'), {
            status: response.statusCode ?? 500,
          }),
        ),
      );
    });
    request.on('error', reject);
    request.setTimeout(5000, () =>
      request.destroy(new Error('State-context HTTP fixture deadline')),
    );
    request.end(data === undefined ? undefined : JSON.stringify(data));
  });
}
async function fixture(platform: 'express' | 'fastify') {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-state-context-'));
  await writeFile(
    join(root, 'context.hbs'),
    '<output>{{query}}</output><b>{{page}}</b><span>{{seenOnMount}}</span>',
  );
  const engine = new HbsEngine({ root });
  await engine.initialize();
  // A deliberate shared host-owned bag makes identity/tenant namespace tests meaningful.
  // This fixture is not a replacement for production session/auth middleware.
  const session: Record<string, unknown> = {};
  let calls = 0;
  @Injectable()
  class ActionGuard implements CanActivate {
    canActivate(context: ExecutionContext) {
      return (
        context.switchToHttp().getRequest<HostRequest>().headers['x-block'] !==
        'yes'
      );
    }
  }
  @Module({ providers: [ActionGuard], exports: [ActionGuard] })
  class Policies {}
  @LiveComponent({ name: 'state-context', view: 'context' })
  class Context {
    @Url({ key: 'q', except: '' })
    @Session({ ttl: 60_000 })
    @State({
      writable: true,
      validate: (value) => typeof value === 'string' && value.length <= 100,
    })
    query = '';
    @Url({ history: 'push', except: 1 })
    @State({
      writable: true,
      validate: (value) =>
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= 10,
    })
    page = 1;
    @State() seenOnMount = '';
    mount() {
      this.seenOnMount = `${this.query}:${this.page}`;
    }
    @Action()
    @UseGuards(ActionGuard)
    save() {
      calls++;
    }
    @Action()
    @UseGuards(ActionGuard)
    reset() {
      calls++;
      this.query = '';
      this.page = 1;
    }
    @Action()
    explode() {
      calls++;
      this.query = 'must-not-persist';
      throw new Error('private-host-failure');
    }
  }
  @Controller()
  class Host {
    constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
    @Get('mount') async mount(@Req() request: object) {
      return { html: (await this.live.mount(Context, request)).value };
    }
    @Get('api/health') health() {
      return { ok: true };
    }
  }
  const module = await Test.createTestingModule({
    controllers: [Host],
    imports: [
      LiveModule.register({
        imports: [Policies],
        components: [Context],
        renderer: engine,
        origin,
        resolveIdentity(request) {
          const headers: unknown = Reflect.get(request, 'headers');
          const selected: unknown =
            headers && typeof headers === 'object'
              ? Reflect.get(headers, 'x-user')
              : undefined;
          const missing: unknown =
            headers && typeof headers === 'object'
              ? Reflect.get(headers, 'x-no-session')
              : undefined;
          if (missing !== 'yes')
            Object.defineProperty(request, 'session', {
              value: session,
              configurable: true,
            });
          const principals: Readonly<Record<string, string>> = {
            alice: 'tenant-a/session-alice/user-alice',
            bob: 'tenant-a/session-bob/user-bob',
            switched: 'tenant-b/session-alice/user-alice',
            denied: 'tenant-a/session-denied/user-denied',
          };
          return {
            binding:
              principals[typeof selected === 'string' ? selected : 'alice'] ??
              principals['denied'] ??
              '',
            csrfToken: csrf,
          };
        },
        authorize(identity, component, action) {
          return (
            !identity.binding.endsWith('user-denied') &&
            component === 'state-context' &&
            ['$mount', '$sync', 'save', 'reset', 'explode'].includes(action)
          );
        },
      }),
    ],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  resources.push({ app, engine, root });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  async function mount(query = '', headers: Record<string, string> = {}) {
    const response = await jsonRequest(base + '/mount' + query, 'GET', headers);
    const json = (await response.json()) as { html?: string; code?: string };
    const html = json.html ?? '';
    return {
      response,
      json,
      html,
      snapshot: /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '',
    };
  }
  function post(
    snapshot: string,
    revision = 0,
    options: {
      action?: string;
      query?: string;
      headers?: Record<string, string>;
      updates?: object;
    } = {},
  ) {
    return jsonRequest(
      base +
        '/_nestvexa/live/state-context/' +
        (options.action ?? 'save') +
        (options.query ?? ''),
      'POST',
      {
        origin,
        'content-type': 'application/json',
        'x-nestvexa-csrf': csrf,
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
  return { app, base, mount, post, session, calls: () => calls };
}

describe.each(['express', 'fastify'] as const)(
  'URL/session HTTP integration (%s)',
  (platform) => {
    it('hydrates validated aliases before mount hooks and escapes template state', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount('?q=%3Cscript%3E&page=2');
      expect(mounted.response.status).toBe(200);
      expect(mounted.html).toContain(
        '<output>&lt;script&gt;</output><b>2</b><span>&lt;script&gt;:2</span>',
      );
      const saved = await f.post(mounted.snapshot);
      expect(saved.status).toBe(201);
      const reply = (await saved.json()) as Reply;
      expect(reply.state.query).toBe('<script>');
      expect(reply.state.seenOnMount).toBe('<script>:2');
      expect(reply.url).toEqual([
        { key: 'q', value: '<script>', history: 'replace' },
        { key: 'page', value: '2', history: 'push' },
      ]);
      expect(f.calls()).toBe(1);
      expect(
        (await jsonRequest(f.base + '/api/health', 'GET', {})).status,
      ).toBe(200);
    });
    it('persists successful actions and remounts, while query values take precedence', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount('?q=initial');
      const response = await f.post(mounted.snapshot, 0, {
        updates: { query: 'saved', page: 3 },
      });
      expect(response.status).toBe(201);
      const remounted = await f.mount();
      expect(remounted.html).toContain(
        '<output>saved</output><b>1</b><span>saved:1</span>',
      );
      expect((await f.mount('?q=explicit')).html).toContain(
        '<output>explicit</output>',
      );
      const result = (await response.json()) as Reply;
      const reset = await f.post(result.snapshot, 1, { action: 'reset' });
      expect(reset.status).toBe(201);
      expect(((await reset.json()) as Reply).url).toEqual([
        { key: 'q', value: null, history: 'replace' },
        { key: 'page', value: null, history: 'push' },
      ]);
      expect((await f.mount()).html).toContain('<output></output>');
    });
    it('isolates users and tenant switches even inside a shared middleware session bag', async () => {
      const f = await fixture(platform);
      const alice = await f.mount('?q=private-alice');
      const bob = await f.mount('', { 'x-user': 'bob' });
      const switched = await f.mount('', { 'x-user': 'switched' });
      expect(bob.html).toContain('<output></output>');
      expect(switched.html).toContain('<output></output>');
      const before = JSON.stringify(f.session);
      expect(
        (
          await f.post(alice.snapshot, 0, {
            headers: { 'x-user': 'bob' },
            updates: { query: 'stolen' },
          })
        ).status,
      ).toBe(410);
      expect(JSON.stringify(f.session)).toBe(before);
      expect(f.calls()).toBe(0);
      expect((await f.mount()).html).toContain(
        '<output>private-alice</output>',
      );
      expect(JSON.stringify(f.session)).not.toContain('tenant-a/session-alice');
    });
    it('does not hydrate an action from endpoint query or another tab’s remembered state', async () => {
      const f = await fixture(platform);
      const first = await f.mount('?q=first');
      await f.mount('?q=second');
      const response = await f.post(first.snapshot, 0, {
        query: '?q=forged&page=9',
      });
      expect(response.status).toBe(201);
      const reply = (await response.json()) as Reply;
      expect(reply.state.query).toBe('first');
      expect(reply.state.page).toBe(1);
      expect((await f.mount()).html).toContain('<output>first</output>');
    });
    it.each([
      '?page=0',
      '?page=1.5',
      '?page=2&page=3',
      '?q=a&q=b',
      '?page=NaN',
    ])('rejects malformed mount %s without writes', async (query) => {
      const f = await fixture(platform);
      const mounted = await f.mount(query);
      expect(mounted.response.status).toBe(422);
      expect(f.session).toEqual({});
      expect(f.calls()).toBe(0);
    });
    it('requires host session capability, including on action persistence', async () => {
      const f = await fixture(platform);
      const missing = await f.mount('', { 'x-no-session': 'yes' });
      expect(missing.response.status).toBe(503);
      expect(missing.json.code).toBe('SESSION_REQUIRED');
      const mounted = await f.mount('?q=before');
      const before = JSON.stringify(f.session);
      const failed = await f.post(mounted.snapshot, 0, {
        headers: { 'x-no-session': 'yes' },
        updates: { query: 'after' },
      });
      expect(failed.status).toBe(503);
      expect(JSON.stringify(f.session)).toBe(before);
      expect(f.calls()).toBe(1);
      expect((await f.post(mounted.snapshot)).status).toBe(410);
    });
    it('checks method guards, CSRF and state validation before session writes/actions', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount('?q=original');
      const before = JSON.stringify(f.session);
      expect(
        (
          await f.post(mounted.snapshot, 0, {
            headers: { 'x-block': 'yes' },
            updates: { query: 'guarded' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await f.post(mounted.snapshot, 0, {
            headers: { 'x-nestvexa-csrf': 'forged' },
            updates: { query: 'csrf' },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await f.post(mounted.snapshot, 0, {
            updates: { query: 'x'.repeat(101) },
          })
        ).status,
      ).toBe(422);
      expect(
        (await f.post(mounted.snapshot, 0, { updates: { page: 0 } })).status,
      ).toBe(422);
      expect(JSON.stringify(f.session)).toBe(before);
      expect(f.calls()).toBe(0);
      expect((await f.post(mounted.snapshot)).status).toBe(201);
      expect((await f.mount('', { 'x-user': 'denied' })).response.status).toBe(
        403,
      );
    });
    it('does not persist failed action state or permit retry of an uncertain mutation', async () => {
      const f = await fixture(platform);
      const mounted = await f.mount('?q=safe');
      const before = JSON.stringify(f.session);
      const response = await f.post(mounted.snapshot, 0, { action: 'explode' });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('private-host-failure');
      expect(JSON.stringify(f.session)).toBe(before);
      expect(f.calls()).toBe(1);
      expect((await f.post(mounted.snapshot)).status).toBe(410);
      expect((await f.mount()).html).toContain('<output>safe</output>');
    });
  },
);
