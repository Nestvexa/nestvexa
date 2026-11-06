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
  Req,
  Scope,
} from '@nestjs/common';
import type { INestApplication, Type } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import type { RenderOptions, ViewModel } from '../packages/views/dist/index.js';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '../packages/live/dist/index.js';

const resources: {
  app?: INestApplication;
  root: string;
  renderer: HbsEngine;
}[] = [];
const origin = 'http://localhost:3100';
const identity = {
  binding: 'test-session/principal/tenant',
  csrfToken: 'host-csrf-012345678901234567890123456789',
};

@Injectable({ scope: Scope.REQUEST })
class RequestInfo {
  readonly id = randomUUID();
  constructor(@Inject(REQUEST) readonly request: object) {}
}
@Module({ providers: [RequestInfo], exports: [RequestInfo] })
class ServicesModule {}

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app?.close();
    await resource.renderer.dispose();
    await rm(resource.root, { recursive: true, force: true });
  }
});

function component(name: string, initial: number): Type<object> {
  @LiveComponent({ name, view: 'counter' })
  class RegisteredCounter {
    constructor(@Inject(RequestInfo) private readonly info: RequestInfo) {}
    @State() count = initial;
    @State() requestScope = '';
    mount(): void {
      this.requestScope = this.info.id;
    }
    @Action() increment(): void {
      this.count++;
    }
  }
  return RegisteredCounter;
}

interface MountGate {
  readonly point: 'authorize' | 'render';
  readonly entered: () => void;
  readonly wait: Promise<void>;
}
function deferred() {
  let resolve: () => void = () => {
    throw new Error('Deferred promise not initialized');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

async function application(
  platform: 'express' | 'fastify',
  firstName: string,
  secondName: string,
  gate?: MountGate,
) {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-registration-'));
  await writeFile(
    join(root, 'counter.hbs'),
    '<output>{{count}}</output><code>{{requestScope}}</code>',
  );
  class MountRenderer extends HbsEngine {
    override async render(
      view: string,
      model: ViewModel,
      options?: RenderOptions,
    ): Promise<string> {
      const html = await super.render(view, model, options);
      if (gate?.point === 'render') {
        gate.entered();
        await gate.wait;
      }
      return html;
    }
  }
  const renderer = new MountRenderer({ root });
  await renderer.initialize();
  const resource: {
    app?: INestApplication;
    root: string;
    renderer: HbsEngine;
  } = { root, renderer };
  resources.push(resource);
  const first = component(firstName, 1);
  const second = component(secondName, 100);
  const imports = [first, second].map((type, index) =>
    LiveModule.register({
      components: [type],
      imports: [ServicesModule],
      renderer,
      origin,
      resolveIdentity: () => identity,
      authorize: async (_identity, name, action) => {
        if (gate?.point === 'authorize' && action === '$mount') {
          gate.entered();
          await gate.wait;
        }
        return name === (index === 0 ? firstName : secondName);
      },
    }),
  );
  @Controller()
  class MountController {
    constructor(@Inject(LiveRuntime) private readonly runtime: LiveRuntime) {}
    @Get('mounts')
    async mounts(@Req() request: object) {
      const [firstHtml, secondHtml] = await Promise.all([
        this.runtime.mount(first, request),
        this.runtime.mount(second, request),
      ]);
      return { first: firstHtml.value, second: secondHtml.value };
    }
  }
  const module = await Test.createTestingModule({
    imports,
    controllers: [MountController],
  }).compile();
  const app =
    platform === 'fastify'
      ? module.createNestApplication(new FastifyAdapter(), { logger: false })
      : module.createNestApplication({ logger: false });
  resource.app = app;
  return { app, module, first, second };
}

describe.each(['express', 'fastify'] as const)(
  'Live registration boundaries: %s',
  (platform) => {
    it('rejects conflicting component/action routes across separate registrations before accepting traffic', async () => {
      await expect(
        application(platform, 'counter', 'counter').then(async ({ app }) => {
          await app.init();
        }),
      ).rejects.toThrow();
    });

    it('delegates an unscoped runtime mount to the correct registered policy and state owner', async () => {
      const { app, module, first, second } = await application(
        platform,
        'first-counter',
        'second-counter',
      );
      await app.listen(0, '127.0.0.1');
      const runtime = app.get(LiveRuntime);
      const owners = module.get(LiveRuntime, { each: true });
      for (const [type, expectedCount] of [
        [first, 2],
        [second, 101],
      ] as const) {
        const html = (await runtime.mount(type, {})).value;
        const name = /data-nv-name="([^"]+)"/.exec(html)?.[1];
        const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
        if (!name || !snapshot) throw new Error('Missing mount metadata');
        const response = await fetch(
          `${await app.getUrl()}/_nestvexa/live/${name}/increment`,
          {
            method: 'POST',
            headers: {
              origin,
              'content-type': 'application/json',
              'x-nestvexa-csrf': identity.csrfToken,
            },
            body: JSON.stringify({
              protocol: 'nestvexa-live/1',
              requestId: randomUUID(),
              snapshot,
              revision: 0,
              updates: {},
              input: null,
            }),
          },
        );
        expect(response.status).toBe(201);
        expect(await response.json()).toMatchObject({
          state: { count: expectedCount },
        });
      }
      expect(owners.map((owner) => memoryStore(owner).size)).toEqual([1, 1]);
      await app.close();
      expect(owners.map((owner) => memoryStore(owner).size)).toEqual([0, 0]);
      await expect(runtime.mount(first, {})).rejects.toThrow();
    });

    it('isolates registration ownership and shutdown across separate application instances', async () => {
      const firstApp = await application(
        platform,
        'first-counter',
        'second-counter',
      );
      const secondApp = await application(
        platform,
        'first-counter',
        'second-counter',
      );
      await firstApp.app.listen(0, '127.0.0.1');
      await secondApp.app.listen(0, '127.0.0.1');
      const firstRuntime = firstApp.app.get(LiveRuntime);
      const secondRuntime = secondApp.app.get(LiveRuntime);
      const mounted = (await firstRuntime.mount(firstApp.first, {})).value;
      const token = /data-nv-snapshot="([^"]+)"/.exec(mounted)?.[1];
      if (!token) throw new Error('Missing first-app state');
      const wrongApp = await fetch(
        `${await secondApp.app.getUrl()}/_nestvexa/live/first-counter/increment`,
        {
          method: 'POST',
          headers: {
            origin,
            'content-type': 'application/json',
            'x-nestvexa-csrf': identity.csrfToken,
          },
          body: JSON.stringify({
            protocol: 'nestvexa-live/1',
            requestId: randomUUID(),
            snapshot: token,
            revision: 0,
            updates: {},
            input: null,
          }),
        },
      );
      expect(wrongApp.status).toBe(410);
      await firstApp.app.close();
      await expect(
        secondRuntime.mount(secondApp.first, {}),
      ).resolves.toHaveProperty('value');
    });

    it('reuses request-scoped imports for simultaneous mounts from one singleton host route and isolates the next request', async () => {
      const { app } = await application(
        platform,
        'first-counter',
        'second-counter',
      );
      await app.listen(0, '127.0.0.1');
      async function scopes(): Promise<readonly [string, string]> {
        const response = await fetch(`${await app.getUrl()}/mounts`);
        expect(response.status).toBe(200);
        const value: unknown = await response.json();
        if (
          typeof value !== 'object' ||
          value === null ||
          !('first' in value) ||
          !('second' in value) ||
          typeof value.first !== 'string' ||
          typeof value.second !== 'string'
        )
          throw new Error('Invalid mount response');
        const firstScope = /<code>([^<]+)<\/code>/.exec(value.first)?.[1];
        const secondScope = /<code>([^<]+)<\/code>/.exec(value.second)?.[1];
        if (!firstScope || !secondScope)
          throw new Error('Missing scoped service evidence');
        return [firstScope, secondScope];
      }
      const first = await scopes();
      const second = await scopes();
      expect(first[0]).toBe(first[1]);
      expect(second[0]).toBe(second[1]);
      expect(first[0]).not.toBe(second[0]);
    });

    it.each(['authorize', 'render'] as const)(
      'does not recreate state when an in-flight mount resumes after shutdown during %s',
      async (point) => {
        const entered = deferred();
        const resume = deferred();
        const { app, module, first } = await application(
          platform,
          'first-counter',
          'second-counter',
          { point, entered: entered.resolve, wait: resume.promise },
        );
        await app.listen(0, '127.0.0.1');
        const runtime = app.get(LiveRuntime);
        const result = expect(runtime.mount(first, {})).rejects.toMatchObject({
          status: 503,
        });
        try {
          await entered.promise;
          await app.close();
        } finally {
          resume.resolve();
        }
        await result;
        expect(
          module
            .get(LiveRuntime, { each: true })
            .map((owner) => memoryStore(owner).size),
        ).toEqual([0, 0]);
      },
    );

    it('keeps disjoint registrations independently routable when their runtime is selected explicitly', async () => {
      const { app, module, first, second } = await application(
        platform,
        'first-counter',
        'second-counter',
      );
      await app.listen(0, '127.0.0.1');
      const runtimes = module.get(LiveRuntime, { each: true });
      expect(runtimes).toHaveLength(2);
      expect(runtimes[0]).not.toBe(runtimes[1]);
      const base = await app.getUrl();
      for (const [type, runtime] of [
        [first, runtimes[0]],
        [second, runtimes[1]],
      ] as const) {
        if (!runtime) throw new Error('Missing registered runtime');
        const html = (await runtime.mount(type, {})).value;
        const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
        const name = /data-nv-name="([^"]+)"/.exec(html)?.[1];
        if (!snapshot || !name) throw new Error('Missing mount metadata');
        const response = await fetch(
          `${base}/_nestvexa/live/${name}/increment`,
          {
            method: 'POST',
            headers: {
              origin,
              'content-type': 'application/json',
              'x-nestvexa-csrf': identity.csrfToken,
            },
            body: JSON.stringify({
              protocol: 'nestvexa-live/1',
              requestId: randomUUID(),
              snapshot,
              revision: 0,
              updates: {},
              input: null,
            }),
          },
        );
        expect(response.status).toBe(201);
        const result: unknown = await response.json();
        expect(result).toMatchObject({ component: { name, revision: 1 } });
      }
    });
  },
);
