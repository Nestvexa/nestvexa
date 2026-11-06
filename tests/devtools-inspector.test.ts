import 'reflect-metadata';
import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HbsEngine } from '../packages/engine-hbs/dist/index.js';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '../packages/live/dist/index.js';
import type { LiveInspector } from '../packages/live/dist/index.js';
import {
  DEVTOOLS_SCHEMA,
  DevtoolsInspector,
  DevtoolsModule,
  MemoryInstrumentation,
  requestTracingMiddleware,
} from '../packages/observability/dist/index.js';
import type { DevtoolsSnapshot } from '../packages/observability/dist/index.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const origin = 'http://localhost:3487';
const csrf = 'devtools-csrf-token-0123456789012345678901';
const binding = 'session:devtools-private-binding';
const secrets = [
  'tok-secret-value-123',
  'hunter2-secret',
  binding,
  csrf,
  'devtools-private-binding',
];

@LiveComponent({ name: 'profile', view: 'profile' })
class Profile {
  @State() count = 0;
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length < 100,
  })
  email = '';
  @State() apiToken = 'tok-secret-value-123';
  @State() password = 'hunter2-secret';
  @State() note = '<script>alert(1)</script>';
  @State() errors: Record<string, string> = {};
  mount(): void {
    this.count = 1;
  }
  hydrate(): void {
    // A defined hook: traced as nestvexa.live.hook.
  }
  @Action() save(): void {
    this.count++;
    this.errors = this.email.includes('@')
      ? {}
      : { email: 'Enter a valid <b>email</b>' };
  }
}

@Controller('page')
class PageController {
  constructor(@Inject(LiveRuntime) private readonly live: LiveRuntime) {}
  @Get()
  async page(@Req() request: object): Promise<string> {
    return (await this.live.mount(Profile, request)).value;
  }
}

async function devtoolsApp(
  options: {
    readonly inspector?: LiveInspector;
    readonly environment?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'nestvexa-devtools-'));
  await writeFile(join(root, 'profile.hbs'), '<p>{{count}} {{note}}</p>');
  const renderer = new HbsEngine({ root });
  await renderer.initialize();
  const memory = new MemoryInstrumentation();
  const inspector = new DevtoolsInspector({ environment: 'test' });
  const module = await Test.createTestingModule({
    imports: [
      LiveModule.registerAsync({
        components: [Profile],
        useFactory: () => ({
          renderer,
          origin,
          resolveIdentity: () => ({ binding, csrfToken: csrf }),
          authorize: () => true,
          instrumentation: memory,
          inspector: options.inspector ?? inspector,
        }),
      }),
      DevtoolsModule.register({
        instrumentation: memory,
        inspector,
        authorize: (request) =>
          Reflect.get(Reflect.get(request, 'headers') as object, 'x-dev') ===
          'yes',
        ...(options.environment === undefined
          ? {}
          : { environment: options.environment }),
      }),
    ],
    controllers: [PageController],
  }).compile();
  const app: INestApplication = module.createNestApplication({ logger: false });
  app.use(requestTracingMiddleware(memory));
  await app.listen(0, '127.0.0.1');
  cleanup.push(async () => {
    await app.close();
    await renderer.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const page = await fetch(`${base}/page`);
  const html = await page.text();
  const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1] ?? '';
  const post = (
    action: string,
    revision: number,
    updates: Record<string, unknown> = {},
    token = csrf,
  ) =>
    fetch(`${base}/_nestvexa/live/profile/${action}`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-nestvexa-csrf': token,
      },
      body: JSON.stringify({
        protocol: 'nestvexa-live/1',
        requestId: randomUUID(),
        snapshot,
        revision,
        updates,
        input: null,
      }),
    });
  const dev = (path = '') =>
    fetch(`${base}/_nestvexa/devtools${path}`, { headers: { 'x-dev': 'yes' } });
  const data = async () =>
    (await (await dev('/data.json')).json()) as DevtoolsSnapshot;
  return { base, page, post, dev, data, memory, inspector };
}

describe('devtools Live inspector', () => {
  it('lists registered components, re-render causes and redacted public state', async () => {
    const f = await devtoolsApp();
    expect(f.page.status).toBe(200);
    expect((await f.post('save', 0, { email: 'not-an-email' })).status).toBe(
      201,
    );
    expect(
      (await f.post('_sync', 1, { email: 'ada@example.test' })).status,
    ).toBe(201);
    const data = await f.data();
    expect(data.schema).toBe(DEVTOOLS_SCHEMA);
    expect(data.components).toEqual([
      expect.objectContaining({
        name: 'profile',
        view: 'profile',
        actions: ['save'],
        lazy: false,
        realtime: false,
      }),
    ]);
    expect(data.components[0]?.states).toContainEqual({
      name: 'email',
      writable: true,
    });
    expect(
      data.renders.map((render) => [render.cause, render.revision]),
    ).toEqual([
      ['sync', 2],
      ['action', 1],
      ['mount', 0],
    ]);
    const [sync, action, mount] = data.renders;
    expect(sync?.fields).toEqual(['email']);
    expect(action).toMatchObject({ action: 'save', fields: ['email'] });
    expect(action?.validationErrors).toEqual([
      { field: 'email', message: 'Enter a valid <b>email</b>' },
    ]);
    expect(mount?.state).toMatchObject({
      count: 1,
      apiToken: '[redacted]',
      password: '[redacted]',
      note: '<script>alert(1)</script>',
    });
    expect(mount?.stateBytes).toBeGreaterThan(50);
    expect(mount?.htmlBytes).toBeGreaterThan(0);
    // Renderer counts and lifecycle hooks come from the spans.
    expect(data.renderers).toContainEqual({ renderer: 'live', count: 3 });
    expect(
      data.hooks.map((record) => record.attributes['nestvexa.hook']),
    ).toEqual(expect.arrayContaining(['mount', 'hydrate']));
    const serialized = JSON.stringify(data);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
  });

  it('correlates requests, actions and renders by request id', async () => {
    const f = await devtoolsApp();
    const response = await f.post('save', 0, { email: 'x' });
    const requestId = response.headers.get('x-request-id') ?? '';
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const data = await f.data();
    expect(data.renders[0]?.requestId).toBe(requestId);
    const action = data.actions.find(
      (record) => record.name === 'nestvexa.live.action',
    );
    expect(action).toMatchObject({
      requestId,
      attributes: {
        'nestvexa.component': 'profile',
        'nestvexa.action': 'save',
      },
    });
    expect(action?.attributes['nestvexa.response_html_bytes']).toBeGreaterThan(
      0,
    );
    const request = data.requests.find(
      (record) => record.requestId === requestId,
    );
    expect(request?.attributes).toMatchObject({
      'nestvexa.http.method': 'POST',
      'nestvexa.http.status': 201,
    });
  });

  it('shows CSRF and authorization rejections with their closed error code', async () => {
    const f = await devtoolsApp();
    expect(
      (await f.post('save', 0, {}, 'forged-token-0123456789012345678901'))
        .status,
    ).toBe(403);
    const data = await f.data();
    expect(data.errors[0]).toMatchObject({
      name: 'nestvexa.live.admit',
      outcome: 'error',
      attributes: {
        'nestvexa.component': 'profile',
        'nestvexa.action': 'save',
        status: 403,
        'nestvexa.error_code': 'CSRF_REJECTED',
      },
    });
    const html = await (await f.dev()).text();
    expect(html).toContain('CSRF_REJECTED');
    expect(html).not.toContain('forged-token');
  });

  it('renders an escaped, script-free page with a strict CSP and an authorized stylesheet', async () => {
    const f = await devtoolsApp();
    await f.post('save', 0, { email: 'x' });
    const response = await f.dev();
    const html = await response.text();
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(html).not.toMatch(/<script|\sstyle=|\son[a-z]+=/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Enter a valid &lt;b&gt;email&lt;/b&gt;');
    expect(html).toContain('<code>profile</code>');
    expect(html).toContain('href="/_nestvexa/devtools/devtools.css"');
    for (const secret of secrets) expect(html).not.toContain(secret);
    const css = await f.dev('/devtools.css');
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toContain('--nv-fg');
    expect(await (await f.dev('?refresh=5')).text()).toContain(
      '<meta http-equiv="refresh" content="5">',
    );
    for (const value of ['1', '61', '5.5', 'x'])
      expect(await (await f.dev(`?refresh=${value}`)).text()).not.toContain(
        'http-equiv',
      );
  });

  it('requires the host authorization for every devtools resource', async () => {
    const f = await devtoolsApp();
    for (const path of ['', '/data.json', '/spans.json', '/devtools.css'])
      expect(
        (await fetch(`${f.base}/_nestvexa/devtools${path}`)).status,
        path,
      ).toBe(403);
    expect((await f.dev('/unknown')).status).toBe(404);
  });

  it('refuses production for the inspector, the module and a process switched to production', async () => {
    expect(() => new DevtoolsInspector({ environment: 'production' })).toThrow(
      /must not be created in production/,
    );
    expect(() => new DevtoolsInspector({ capacity: 0 })).toThrow(/capacity/);
    const f = await devtoolsApp();
    const saved = process.env['NODE_ENV'];
    try {
      process.env['NODE_ENV'] = 'production';
      expect((await f.dev()).status).toBe(404);
      expect((await f.dev('/data.json')).status).toBe(404);
    } finally {
      process.env['NODE_ENV'] = saved;
    }
    expect((await f.dev()).status).toBe(200);
  });

  it('never lets a failing inspector break Live requests and bounds stored renders', async () => {
    const broken: LiveInspector = {
      registered() {
        throw new Error('inspector down');
      },
      rendered() {
        throw new Error('inspector down');
      },
    };
    const f = await devtoolsApp({ inspector: broken });
    expect(f.page.status).toBe(200);
    expect((await f.post('save', 0)).status).toBe(201);
    const small = new DevtoolsInspector({
      environment: 'test',
      capacity: 2,
      maxStateBytes: 16,
    });
    for (let revision = 0; revision < 3; revision++)
      small.rendered({
        component: 'profile',
        cause: 'action',
        action: 'save',
        fields: [],
        revision,
        state: { large: 'x'.repeat(100) },
        stateBytes: 110,
        htmlBytes: 10,
      });
    expect(small.renders.map((render) => render.revision)).toEqual([2, 1]);
    expect(small.renders[0]?.state).toEqual({
      '[elided]': `${JSON.stringify({ large: 'x'.repeat(100) }).length} bytes`,
    });
    small.rendered({
      component: 'Not A Name',
      cause: 'mount',
      fields: [],
      revision: 0,
      state: {},
      stateBytes: 0,
      htmlBytes: 0,
    });
    expect(small.renders).toHaveLength(2);
  });
});
