import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Controller, Get, Inject, Module, Render, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  CoreModule,
  DiagnosticsRegistry,
  FeatureCapabilityRegistry,
  NestvexaExtensionHost,
  RequestContextFactory,
} from '@nestvexa/core';
import {
  Action,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
} from '@nestvexa/live';
import { ViewEngineRegistry } from '@nestvexa/views';
// Third-party packages, installed from their own tarballs.
import { MiniEngine } from 'nestvexa-engine-mini';
import { auditExtension } from 'nestvexa-extension-mini';

// MAINT-007: a view-engine adapter and an extension written outside the
// repository against the public API, packed, installed next to the Nestvexa
// tarballs and booted in a Nest application: MVC pages and Live fragments
// render through the adapter, and the extension joins the kernel registries.

const root = fileURLToPath(new URL('../views', import.meta.url));
const engine = new MiniEngine({ root, defaultLayout: 'layout' });
const registry = new ViewEngineRegistry();
registry.register(engine);
registry.requireAll('mini', ['layouts', 'safeHtml']);
assert.throws(
  () => registry.requireAll('mini', ['partials']),
  /Engine mini does not support partials/,
);
let shutdowns = 0;
const origin = 'http://localhost';
const csrf = 'third-party-packed-csrf-0123456789abcdef';

@LiveComponent({ name: 'mini-counter', view: 'counter' })
class Counter {
  @State() count = 0;
  @Action() increment(): void {
    this.count++;
  }
}
@Controller()
class Home {
  constructor(
    @Inject(LiveRuntime) private readonly live: LiveRuntime,
    @Inject(RequestContextFactory)
    private readonly contexts: RequestContextFactory,
  ) {}
  @Get()
  @Render('home')
  async index(@Req() request: object) {
    const context = await this.contexts.create(request);
    return {
      title: '<b>unsafe</b>',
      tenant: String(context.extensions['mini.audit']?.['tenant']),
      widget: await this.live.mount(Counter, request),
    };
  }
}
class EngineLifecycle {
  onModuleInit(): Promise<void> {
    return engine.initialize();
  }
}
@Module({
  imports: [
    CoreModule.forRoot(
      {},
      {
        extensions: [
          auditExtension({
            tenant: 'acme',
            onShutdown: () => {
              shutdowns++;
            },
          }),
        ],
      },
    ),
    LiveModule.register({
      components: [Counter],
      renderer: engine,
      origin,
      // Fixed identity is a hermetic packaging fixture, not an authentication starter.
      resolveIdentity: () => ({
        binding: 'third-party-session',
        csrfToken: csrf,
      }),
      authorize: (_identity, component, action) =>
        component === 'mini-counter' &&
        ['$mount', 'increment'].includes(action),
    }),
  ],
  controllers: [Home],
  providers: [EngineLifecycle],
})
class Host {}

/** The part of the Express application the MVC bridge uses (no @types/express needed). */
interface ExpressViews {
  engine(
    extension: string,
    render: (
      filename: string,
      options: Record<string, unknown>,
      done: (error: Error | null, html?: string) => void,
    ) => void,
  ): unknown;
  set(setting: string, value: unknown): unknown;
}
const app = await NestFactory.create(Host, { logger: false });
const express: ExpressViews = app.getHttpAdapter().getInstance();
express.engine('mini', (filename, options, done) =>
  engine.renderFile(filename, options, done),
);
express.set('views', root);
express.set('view engine', 'mini');
try {
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  assert.deepEqual(app.get(NestvexaExtensionHost).describe(), [
    { name: 'mini.audit', version: '1.0.0' },
  ]);
  assert.equal(app.get(FeatureCapabilityRegistry).has('mini.audit'), true);
  assert.equal(
    app.get(DiagnosticsRegistry).recent({ prefix: 'mini.audit.registered' })
      .length,
    1,
  );

  const page = await fetch(base);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.startsWith('<!doctype html><main>'), html);
  assert.ok(html.includes('<h1>&lt;b&gt;unsafe&lt;/b&gt;</h1>'), html);
  assert.ok(!html.includes('<b>unsafe</b>'));
  assert.ok(html.includes('<p>tenant acme</p>'), html);
  assert.ok(html.includes('<output>0</output>'), html);
  assert.ok(html.includes('data-nv-endpoint="/_nestvexa/live/mini-counter"'));

  const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
  assert.ok(snapshot);
  const action = `${base}/_nestvexa/live/mini-counter/increment`;
  const body = JSON.stringify({
    protocol: 'nestvexa-live/1',
    requestId: randomUUID(),
    snapshot,
    revision: 0,
    updates: {},
    input: null,
  });
  const headers = {
    'content-type': 'application/json',
    origin,
    'x-nestvexa-csrf': csrf,
  };
  const forged = await fetch(action, {
    method: 'POST',
    headers: { ...headers, 'x-nestvexa-csrf': 'forged' },
    body,
  });
  assert.equal(forged.status, 403);
  const updated = await fetch(action, { method: 'POST', headers, body });
  assert.equal(updated.status, 201);
  const result: unknown = await updated.json();
  assert.ok(typeof result === 'object' && result !== null && 'html' in result);
  // Live fragments render through the third-party adapter without its layout.
  assert.equal(result.html, '<output>1</output>');

  // The adapter keeps the kit's containment and model rules.
  await assert.rejects(engine.render('../outside', {}), {
    code: 'INVALID_VIEW',
  });
  await assert.rejects(
    engine.render(
      'home',
      JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>,
    ),
    { code: 'UNSAFE_MODEL' },
  );
  await assert.rejects(engine.render('home', {}, { theme: 'dark' }), {
    code: 'UNSUPPORTED_CAPABILITY',
  });
} finally {
  await app.close();
}
assert.equal(shutdowns, 1);
console.log(
  'Third-party view engine and extension packages (installed from their own tarballs) rendered MVC pages and Live fragments, joined the kernel registries and shut down cleanly.',
);
