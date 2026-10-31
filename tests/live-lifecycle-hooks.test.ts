import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Controller,
  Get,
  HttpException,
  Inject,
  Module,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  Session,
  State,
} from '../packages/live/dist/index.js';
import type {
  LiveRenderContext,
  LiveUpdateContext,
} from '../packages/live/dist/index.js';

const origin = 'http://localhost';
const csrf = 'lifecycle-test-csrf-012345678901234567890123456789';
const resources: { app: INestApplication; engine: HbsEngine; root: string }[] =
  [];
afterEach(async () => {
  for (const entry of resources.splice(0)) {
    await entry.app.close();
    await entry.engine.dispose();
    if (!resolve(entry.root).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected lifecycle fixture path');
    await rm(entry.root, { recursive: true, force: true });
  }
});

interface HostRequest {
  headers: Record<string, string | undefined>;
  session?: object;
}
interface Reply {
  snapshot: string;
  state: { count: number };
  html: string;
  component: { revision: number };
}
async function fixture(platform: 'express' | 'fastify') {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-lifecycle-'));
  await writeFile(join(root, 'hooks.hbs'), '<output>{{count}}</output>');
  const engine = new HbsEngine({ root });
  await engine.initialize();
  const calls: string[] = [];
  const failures: unknown[] = [];
  const session: Record<string, unknown> = {};
  @LiveComponent({ name: 'hooks', view: 'hooks' })
  class Hooks {
    @Session() @State({ writable: true }) count = 0;
    constructor(@Inject(REQUEST) readonly request: HostRequest) {}
    private async step(stage: string): Promise<void> {
      calls.push(stage);
      await Promise.resolve();
      if (this.request.headers['x-fail'] === stage)
        throw new HttpException({ code: `FAIL_${stage}` }, 418);
    }
    async boot() {
      await this.step('boot');
    }
    async mount() {
      await this.step('mount');
    }
    async hydrate() {
      await this.step('hydrate');
    }
    async beforeUpdate(context: LiveUpdateContext) {
      expect(Object.isFrozen(context)).toBe(true);
      await this.step('beforeUpdate');
    }
    async afterUpdate() {
      await this.step('afterUpdate');
    }
    async beforeAction() {
      await this.step('beforeAction');
    }
    async afterAction() {
      await this.step('afterAction');
    }
    async dehydrate() {
      await this.step('dehydrate');
    }
    async beforeRender() {
      await this.step('beforeRender');
    }
    async afterRender(context: LiveRenderContext) {
      expect(Object.isFrozen(context)).toBe(true);
      expect(context.html).toBe(`<output>${this.count}</output>`);
      await this.step('afterRender');
      this.count = 9999;
    }
    async onError(error: unknown) {
      calls.push('onError');
      failures.push(error);
      if (this.request.headers['x-secondary'] === 'yes')
        throw new Error('secondary-diagnostic-secret');
    }
    async dispose() {
      this.count = 8888;
      await this.step('dispose');
      if (this.request.headers['x-secondary'] === 'yes')
        throw new Error('secondary-disposal-secret');
    }
    @Action() async increment() {
      await this.step('action');
      this.count++;
    }
  }
  @Controller()
  class Home {
    constructor(@Inject(LiveRuntime) readonly runtime: LiveRuntime) {}
    @Get() async home(@Req() request: HostRequest) {
      return { html: (await this.runtime.mount(Hooks, request)).value };
    }
  }
  @Module({
    imports: [
      LiveModule.register({
        components: [Hooks],
        renderer: engine,
        origin,
        // Trusted host context fixture on the actual adapter request, not production session middleware.
        resolveIdentity: (request) => {
          Object.defineProperty(request, 'session', {
            value: session,
            configurable: true,
          });
          return {
            binding: 'lifecycle-authoritative-session',
            csrfToken: csrf,
          };
        },
        authorize: () => true,
      }),
    ],
    controllers: [Home],
  })
  class Host {}
  const testing = await Test.createTestingModule({ imports: [Host] }).compile();
  const app =
    platform === 'fastify'
      ? testing.createNestApplication(new FastifyAdapter())
      : testing.createNestApplication();
  app.useLogger(false);
  resources.push({ app, engine, root });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const runtime = app.get(LiveRuntime);
  async function mount(headers: Record<string, string> = {}) {
    const response = await fetch(base, { headers });
    if (!response.ok) return { response, snapshot: '', revision: 0 };
    const body = (await response.json()) as { html: string };
    const snapshot = /data-nv-snapshot="([^"]+)"/.exec(body.html)?.[1];
    if (!snapshot) throw new Error('Missing lifecycle mount snapshot');
    return { response, snapshot, revision: 0, html: body.html };
  }
  async function action(
    snapshot: string,
    headers: Record<string, string> = {},
    updates: object = {},
  ) {
    return fetch(base + '/_nestvexa/live/hooks/increment', {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-nestvexa-csrf': csrf,
        ...headers,
      },
      body: JSON.stringify({
        protocol: 'nestvexa-live/1',
        requestId: crypto.randomUUID(),
        snapshot,
        revision: 0,
        updates,
        input: null,
      }),
    });
  }
  return { mount, action, calls, failures, runtime, session };
}

describe.each(['express', 'fastify'] as const)(
  'awaited request lifecycle on %s',
  (platform) => {
    it('captures rendered state before observation/cleanup and disposes exactly once before committing', async () => {
      const host = await fixture(platform);
      const mounted = await host.mount();
      expect(mounted.response.status).toBe(200);
      expect(mounted.html).toContain('<output>0</output>');
      expect(host.calls).toEqual([
        'boot',
        'mount',
        'dehydrate',
        'beforeRender',
        'afterRender',
        'dispose',
      ]);
      expect(
        host.runtime.store.peek(
          mounted.snapshot,
          'lifecycle-authoritative-session',
        ).state,
      ).toEqual({ count: 0 });
      host.calls.length = 0;
      const response = await host.action(mounted.snapshot, {}, { count: 2 });
      expect(response.status).toBe(201);
      const body = (await response.json()) as Reply;
      expect(body.state.count).toBe(3);
      expect(body.html).toBe('<output>3</output>');
      expect(host.calls).toEqual([
        'boot',
        'hydrate',
        'beforeUpdate',
        'afterUpdate',
        'beforeAction',
        'action',
        'afterAction',
        'dehydrate',
        'beforeRender',
        'afterRender',
        'dispose',
      ]);
      expect(host.failures).toEqual([]);
      const fresh = await host.mount();
      expect(fresh.html).toContain('<output>3</output>');
    });
    it.each([
      'boot',
      'mount',
      'dehydrate',
      'beforeRender',
      'afterRender',
      'dispose',
    ])(
      'mount failure in %s observes once, disposes once, and creates no snapshot/session state',
      async (stage) => {
        const host = await fixture(platform);
        const result = await host.mount({ 'x-fail': stage });
        expect(result.response.status).toBe(418);
        expect(host.calls.filter((name) => name === 'onError')).toHaveLength(1);
        expect(host.calls.filter((name) => name === 'dispose')).toHaveLength(1);
        expect(host.failures).toHaveLength(1);
        expect(host.runtime.store.size).toBe(0);
        expect(host.session).toEqual({});
      },
    );
    it.each([
      'boot',
      'hydrate',
      'beforeUpdate',
      'afterUpdate',
      'beforeAction',
      'action',
      'afterAction',
      'dehydrate',
      'beforeRender',
      'afterRender',
      'dispose',
    ])(
      'action failure in %s revokes the uncertain snapshot and never persists cleanup state',
      async (stage) => {
        const host = await fixture(platform);
        const initial = await host.mount();
        const session = structuredClone(host.session);
        host.calls.length = 0;
        const response = await host.action(
          initial.snapshot,
          { 'x-fail': stage },
          { count: 1 },
        );
        expect(response.status).toBe(418);
        expect(host.calls.filter((name) => name === 'onError')).toHaveLength(1);
        expect(host.calls.filter((name) => name === 'dispose')).toHaveLength(1);
        expect(host.session).toEqual(session);
        expect(host.runtime.store.size).toBe(0);
        expect((await host.action(initial.snapshot)).status).toBe(410);
      },
    );
    it('preserves the original HTTP exception when both diagnostic and disposal hooks fail', async () => {
      const host = await fixture(platform);
      const initial = await host.mount();
      host.calls.length = 0;
      const response = await host.action(initial.snapshot, {
        'x-fail': 'action',
        'x-secondary': 'yes',
      });
      expect(response.status).toBe(418);
      expect(await response.json()).toEqual({ code: 'FAIL_action' });
      expect(host.calls.filter((name) => name === 'onError')).toHaveLength(1);
      expect(host.calls.filter((name) => name === 'dispose')).toHaveLength(1);
    });
    it('does not resolve component hooks for rejected CSRF or locked state admission', async () => {
      const host = await fixture(platform);
      const initial = await host.mount();
      host.calls.length = 0;
      expect(
        (await host.action(initial.snapshot, { 'x-nestvexa-csrf': 'wrong' }))
          .status,
      ).toBe(403);
      expect(
        (await host.action(initial.snapshot, {}, { secret: 'attempt' })).status,
      ).toBe(422);
      expect(host.calls).toEqual([]);
      expect(host.runtime.store.size).toBe(1);
    });
    it('observes final session persistence failures after cleanup and revokes the committed token', async () => {
      const host = await fixture(platform);
      const initial = await host.mount();
      host.calls.length = 0;
      Object.freeze(host.session);
      const response = await host.action(initial.snapshot);
      expect(response.status).toBe(503);
      expect(host.calls.slice(-2)).toEqual(['dispose', 'onError']);
      expect(host.calls.filter((name) => name === 'onError')).toHaveLength(1);
      expect(host.calls.filter((name) => name === 'dispose')).toHaveLength(1);
      expect(host.runtime.store.size).toBe(0);
    });
    it('observes mount session persistence failure after cleanup without leaving a usable snapshot', async () => {
      const host = await fixture(platform);
      Object.preventExtensions(host.session);
      const response = await host.mount();
      expect(response.response.status).toBe(503);
      expect(host.calls.slice(-2)).toEqual(['dispose', 'onError']);
      expect(host.runtime.store.size).toBe(0);
    });
  },
);

it('rejects ineffective Nest guards on request hooks at registration', () => {
  @LiveComponent({ name: 'invalid-hooks', view: 'unused' })
  class Invalid {
    @UseGuards({ canActivate: () => false })
    beforeRender() {
      return;
    }
  }
  expect(() =>
    LiveModule.register({
      components: [Invalid],
      origin,
      renderer: new HbsEngine({ root: process.cwd() }),
      resolveIdentity: () => ({
        binding: 'registration-test-session',
        csrfToken: csrf,
      }),
      authorize: () => true,
    }),
  ).toThrow('cannot use Nest');
});
