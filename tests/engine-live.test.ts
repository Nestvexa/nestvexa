import 'reflect-metadata';
import {
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Module,
  Render,
  Req,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EjsEngine } from '../packages/engine-ejs/dist/index.js';
import { PugEngine } from '../packages/engine-pug/dist/index.js';
import { NunjucksEngine } from '../packages/engine-nunjucks/dist/index.js';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '../packages/live/dist/index.js';
import type { ViewEngineAdapter } from '../packages/views/dist/index.js';
import { TokenEngine } from '../examples/custom-engine/src/engine.js';

/** Every adapter here offers the same Express bridge shape as the HBS adapter. */
interface BridgedEngine extends ViewEngineAdapter {
  renderFile(
    filename: string,
    options: Record<string, unknown>,
    callback: (error: Error | null, html?: string) => void,
  ): void;
}
interface EngineFixture {
  readonly extension: string;
  readonly create: (root: string) => BridgedEngine;
  /** Component template and MVC page, written in the engine's native syntax. */
  readonly counter: string;
  readonly home: string;
}
const engines: Readonly<Record<string, EngineFixture>> = {
  ejs: {
    extension: 'ejs',
    create: (root) => new EjsEngine({ root }),
    counter:
      '<output><%= count %></output><button type="button" nv:click="increment">+</button><p><%= label %></p>',
    home: '<h1><%= title %></h1><%= widget %>',
  },
  pug: {
    extension: 'pug',
    create: (root) => new PugEngine({ root }),
    counter:
      'output= count\nbutton(type="button" nv:click="increment") +\np= label',
    home: 'h1= title\n= widget',
  },
  nunjucks: {
    extension: 'njk',
    create: (root) => new NunjucksEngine({ root }),
    counter:
      '<output>{{ count }}</output><button type="button" nv:click="increment">+</button><p>{{ label }}</p>',
    home: '<h1>{{ title }}</h1>{{ widget }}',
  },
  'custom tokens example': {
    extension: 'tok',
    create: (root) => new TokenEngine({ root }),
    counter:
      '<output>{{ count }}</output><button type="button" nv:click="increment">+</button><p>{{ label }}</p>',
    home: '<h1>{{ title }}</h1>{{ widget }}',
  },
};

const origin = 'http://localhost:3100';
const csrf = 'engine-live-host-csrf-0123456789abcdef';
const resources: {
  app: INestApplication;
  root: string;
  engine: BridgedEngine;
}[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    await resource.engine.dispose();
    await rm(resource.root, { recursive: true, force: true });
  }
});

interface ExpressViews {
  engine(
    extension: string,
    render: (
      filename: string,
      options: Record<string, unknown>,
      callback: (error: Error | null, html?: string) => void,
    ) => void,
  ): unknown;
  set(name: string, value: unknown): unknown;
}
interface ViewReply {
  type(contentType: string): ViewReply;
  send(html: string): unknown;
}
interface FastifyViews {
  decorateReply(
    name: string,
    view: (
      this: ViewReply,
      view: string,
      model: Record<string, unknown>,
    ) => Promise<unknown>,
  ): unknown;
}
function isExpress(host: unknown): host is ExpressViews {
  return (
    (typeof host === 'function' ||
      (typeof host === 'object' && host !== null)) &&
    typeof Reflect.get(host, 'engine') === 'function' &&
    typeof Reflect.get(host, 'set') === 'function'
  );
}
function isFastify(host: unknown): host is FastifyViews {
  return (
    typeof host === 'object' &&
    host !== null &&
    typeof Reflect.get(host, 'decorateReply') === 'function'
  );
}

async function boot(platform: 'express' | 'fastify', fixture: EngineFixture) {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-engine-live-'));
  await writeFile(join(root, `counter.${fixture.extension}`), fixture.counter);
  await writeFile(join(root, `home.${fixture.extension}`), fixture.home);
  const engine = fixture.create(root);
  await engine.initialize();

  @LiveComponent({ name: 'counter', view: 'counter' })
  class Counter {
    @State() count = 0;
    @State({
      writable: true,
      validate: (value) => typeof value === 'string' && value.length <= 80,
    })
    label = '';
    @Action() increment(): void {
      this.count++;
    }
  }
  @Controller()
  class HostController {
    constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
    @Get()
    @Render('home')
    async home(@Req() request: object) {
      return {
        title: '<Hello & welcome>',
        widget: await this.live.mount(Counter, request),
      };
    }
  }
  @Module({
    imports: [
      LiveModule.register({
        components: [Counter],
        renderer: engine,
        origin,
        resolveIdentity: (request) => {
          const headers: unknown = Reflect.get(request, 'headers');
          const session =
            typeof headers === 'object' && headers !== null
              ? Reflect.get(headers, 'x-session')
              : undefined;
          if (session !== 'alice') throw new ForbiddenException();
          return { binding: 'tenant-a/session-alice', csrfToken: csrf };
        },
        authorize: (_identity, component, action) =>
          component === 'counter' &&
          ['$mount', '$sync', 'increment'].includes(action),
      }),
    ],
    controllers: [HostController],
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
  const host: unknown = app.getHttpAdapter().getInstance();
  if (platform === 'express') {
    if (!isExpress(host)) throw new Error('Expected an Express instance');
    host.engine(fixture.extension, (filename, options, callback) =>
      engine.renderFile(filename, options, callback),
    );
    host.set('views', root);
    host.set('view engine', fixture.extension);
  } else {
    if (!isFastify(host)) throw new Error('Expected a Fastify instance');
    host.decorateReply('view', async function (view, model) {
      const html = await engine.render(view, model);
      return this.type('text/html; charset=utf-8').send(html);
    });
  }
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const post = (path: string, body: Record<string, unknown>, token = csrf) =>
    fetch(`${base}/_nestvexa/live/counter/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin,
        'x-session': 'alice',
        'x-nestvexa-csrf': token,
      },
      body: JSON.stringify({
        protocol: 'nestvexa-live/1',
        requestId: randomUUID(),
        updates: {},
        input: null,
        ...body,
      }),
    });
  return { base, post };
}

function component(count: number, label: string): string {
  return `<output>${count}</output><button type="button" nv:click="increment">+</button><p>${label}</p>`;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Record<string, unknown>;
}

describe.each(['express', 'fastify'] as const)(
  'Live components on alternative engines: %s',
  (platform) => {
    it.each(Object.keys(engines))(
      '%s mounts in an MVC page and runs actions and model sync over HTTP',
      async (name) => {
        const fixture = engines[name];
        if (!fixture) throw new Error(`Unknown fixture ${name}`);
        const { base, post } = await boot(platform, fixture);
        const page = await fetch(base, { headers: { 'x-session': 'alice' } });
        expect(page.status).toBe(200);
        const html = await page.text();
        // User text is escaped; the trusted Live mount (markers, snapshot,
        // directives) is emitted as markup without any hand-escaping.
        expect(html.startsWith('<h1>&lt;Hello &amp; welcome&gt;</h1>')).toBe(
          true,
        );
        expect(html).toContain('<div data-nv-component="');
        expect(html).toContain('data-nv-endpoint="/_nestvexa/live/counter"');
        expect(html).toContain(`${component(0, '')}</div>`);
        expect(html).not.toContain('&lt;div data-nv-component');
        const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
        if (!snapshot) throw new Error(`Missing snapshot in ${html}`);

        const increment = await post('increment', { snapshot, revision: 0 });
        expect(increment.status).toBe(201);
        const incremented = record(await increment.json());
        expect(record(incremented['state'])['count']).toBe(1);
        expect(incremented['html']).toBe(component(1, ''));

        const hostile = '<img src=x onerror=alert(1)>';
        const sync = await post('_sync', {
          snapshot,
          revision: 1,
          updates: { label: hostile },
        });
        expect(sync.status).toBe(201);
        const synced = record(await sync.json());
        expect(record(synced['state'])['label']).toBe(hostile);
        expect(synced['html']).toBe(
          component(1, '&lt;img src=x onerror=alert(1)&gt;'),
        );

        const forged = await post(
          'increment',
          { snapshot, revision: 2 },
          'forged-token',
        );
        expect(forged.status).toBe(403);
      },
    );
  },
);
