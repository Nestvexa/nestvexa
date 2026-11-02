import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Controller,
  Get,
  Injectable,
  Module,
  ParseIntPipe,
  Render,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { HbsEngine, NestvexaModule, configureNestvexa } from 'nestvexa';
import { EjsEngine } from '@nestvexa/engine-ejs';
import { PugEngine } from '@nestvexa/engine-pug';
import { NunjucksEngine } from '@nestvexa/engine-nunjucks';
import { SafeHtml, ViewEngineRegistry } from '@nestvexa/views';
import type { ViewEngineAdapter } from '@nestvexa/views';
import type {
  ComputedOptions,
  UrlOptions,
  SessionOptions,
  LiveRenderContext,
} from 'nestvexa';
import {
  Action,
  ActionInput,
  Computed,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  State,
  Url,
  Session,
} from '@nestvexa/live';
import {
  createLiveClient,
  parseDirective,
  parseLoadingDirective,
  parseLoadingTarget,
} from '@nestvexa/client';
import type {
  LiveDirective,
  LoadingDirective,
  ReplacementDirective,
} from '@nestvexa/client';

// Importing a browser entry in Node must not initialize a document or a global runtime.
assert.equal(typeof createLiveClient, 'function');
const replacement: LiveDirective = parseDirective('nv:replace.self', '');
assert.deepEqual(replacement, {
  kind: 'replace',
  self: true,
} satisfies ReplacementDirective);
const loading: LoadingDirective = parseLoadingDirective(
  'nv:loading.attr',
  'disabled',
);
assert.deepEqual(loading, {
  kind: 'loading',
  mode: 'attr',
  remove: false,
  attribute: 'disabled',
});
assert.deepEqual(parseLoadingTarget('increment, $sync'), [
  'increment',
  '$sync',
]);
assert.throws(() => parseLoadingDirective('nv:loading.attr', 'onclick'));
assert.deepEqual(parseDirective('nv:poll.2s', 'refresh'), {
  kind: 'poll',
  value: 'refresh',
  intervalMs: 2000,
});
assert.deepEqual(parseDirective('nv:init.visible', 'load'), {
  kind: 'init',
  value: 'load',
  timing: 'visible',
});
assert.equal(typeof Url({ key: 'q' } satisfies UrlOptions), 'function');
assert.equal(
  typeof Session({ ttl: 1000 } satisfies SessionOptions),
  'function',
);
const renderedContexts: string[] = [];

@Injectable()
class CounterService {
  readonly privateValue = 'fixture-service-data-not-public';
  step(): number {
    return 2;
  }
}
@Injectable()
class ActionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    actionGuardCalls++;
    return (
      context.switchToHttp().getRequest<{ headers: Record<string, string> }>()
        .headers['x-pack-allow'] === 'yes'
    );
  }
}
let actionGuardCalls = 0;
let componentGuardCalls = 0;
let syncAllowed = true;
const computedOptions: ComputedOptions = {
  async: true,
  dependencies: ['count'],
  ttl: 100,
};
@Injectable()
class ComponentGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    componentGuardCalls++;
    return (
      context.switchToHttp().getRequest<{ headers: Record<string, string> }>()
        .headers['x-pack-block'] !== 'yes'
    );
  }
}
@Module({ providers: [CounterService], exports: [CounterService] })
class ServicesModule {}
@LiveComponent({ name: 'packed-counter', view: 'counter' })
@UseGuards(ComponentGuard)
class Counter {
  // No explicit @Inject: external tsc must emit usable Nest constructor metadata.
  constructor(private readonly service: CounterService) {}
  @State() count = 0;
  @State({
    writable: true,
    validate: (value) => typeof value === 'string' && value.length <= 16,
  })
  label = '';
  afterRender(context: LiveRenderContext): void {
    renderedContexts.push(context.html);
  }
  @Computed(computedOptions)
  async doubled(): Promise<number> {
    return this.count * 2;
  }
  @Action()
  @UseGuards(ActionGuard)
  increment(): void {
    this.count += this.service.step();
  }
  @Action()
  set(@ActionInput(new ParseIntPipe()) value: number): void {
    this.count = value;
  }
}
const origin = 'http://localhost';
const csrf = 'packed-consumer-host-csrf-0123456789abcdef';
const renderer = new HbsEngine({ root: 'views' });
@Controller()
class Home {
  constructor(private readonly live: LiveRuntime) {}
  @Get()
  @Render('home')
  async index(@Req() request: object) {
    return {
      message: '<safe>',
      widget: await this.live.mount(Counter, request),
    };
  }
}
@Module({
  imports: [
    NestvexaModule.forRoot({ views: { root: 'views' } }),
    LiveModule.register({
      components: [Counter],
      imports: [ServicesModule],
      renderer,
      origin,
      // This hermetic packaging fixture uses a fixed host identity; cookie/session security has separate tests.
      resolveIdentity: () => ({
        binding: 'packed-consumer/session/principal',
        csrfToken: csrf,
      }),
      authorize: (_identity, component, action) =>
        component === 'packed-counter' &&
        ['$mount', '$sync', 'increment', 'set'].includes(action) &&
        (action !== '$sync' || syncAllowed),
    }),
  ],
  controllers: [Home],
})
class App {}
function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}
const app = await NestFactory.create(App, { logger: false });
try {
  await configureNestvexa(app);
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const response = await fetch(base);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.startsWith('<h1>&lt;safe&gt;</h1>'));
  assert.ok(html.includes('<output>0</output>'));
  assert.ok(html.includes('<b>0</b>'));
  assert.equal(renderedContexts.length, 1);
  assert.ok(!html.includes('fixture-service-data-not-public'));
  const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
  assert.ok(snapshot);
  const headers = {
    'content-type': 'application/json',
    origin,
    'x-nestvexa-csrf': csrf,
  };
  const body = {
    protocol: 'nestvexa-live/1',
    requestId: randomUUID(),
    snapshot,
    revision: 0,
    updates: {},
    input: null,
  };
  const denied = await fetch(
    `${base}/_nestvexa/live/packed-counter/increment`,
    { method: 'POST', headers, body: JSON.stringify(body) },
  );
  assert.equal(denied.status, 403);
  const allowed = await fetch(
    `${base}/_nestvexa/live/packed-counter/increment`,
    {
      method: 'POST',
      headers: { ...headers, 'x-pack-allow': 'yes' },
      body: JSON.stringify(body),
    },
  );
  assert.ok(allowed.ok);
  const result = record(await allowed.json());
  assert.equal(record(result['state'])['count'], 2);
  assert.equal(record(result['component'])['revision'], 1);
  assert.equal(result['html'], '<output>2</output><b>4</b>');
  const updated = await fetch(`${base}/_nestvexa/live/packed-counter/set`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...body,
      requestId: randomUUID(),
      revision: 1,
      input: '7',
    }),
  });
  assert.ok(updated.ok);
  assert.equal(record(record(await updated.json())['state'])['count'], 7);
  const syncBody = {
    ...body,
    requestId: randomUUID(),
    revision: 2,
    updates: { label: 'too long for the declared validator' },
  };
  const syncUrl = `${base}/_nestvexa/live/packed-counter/_sync`;
  const beforePolicyDenial = componentGuardCalls;
  syncAllowed = false;
  const policyDenied = await fetch(syncUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(syncBody),
  });
  assert.equal(policyDenied.status, 403);
  assert.equal(componentGuardCalls, beforePolicyDenial);
  syncAllowed = true;
  const classDenied = await fetch(syncUrl, {
    method: 'POST',
    headers: { ...headers, 'x-pack-block': 'yes' },
    body: JSON.stringify(syncBody),
  });
  assert.equal(classDenied.status, 403);
  assert.equal(componentGuardCalls, beforePolicyDenial + 1);
  const invalid = await fetch(syncUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(syncBody),
  });
  assert.equal(invalid.status, 422);
  assert.equal(record(await invalid.json())['code'], 'STATE_INVALID');
  const actionGuardsBeforeSync = actionGuardCalls;
  const synchronized = await fetch(syncUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...syncBody,
      requestId: randomUUID(),
      updates: { label: '<safe>' },
    }),
  });
  assert.equal(synchronized.status, 201);
  assert.equal(synchronized.headers.get('cache-control'), 'no-store');
  const synchronizedResult = record(await synchronized.json());
  assert.equal(record(synchronizedResult['state'])['label'], '<safe>');
  assert.equal(record(synchronizedResult['state'])['count'], 7);
  assert.equal(record(synchronizedResult['component'])['revision'], 3);
  assert.equal(synchronizedResult['snapshot'], snapshot);
  assert.equal(componentGuardCalls, beforePolicyDenial + 3);
  assert.equal(actionGuardCalls, actionGuardsBeforeSync);
  const replay = await fetch(
    `${base}/_nestvexa/live/packed-counter/increment`,
    {
      method: 'POST',
      headers: { ...headers, 'x-pack-allow': 'yes' },
      body: JSON.stringify(body),
    },
  );
  assert.equal(replay.status, 409);
  console.log(
    'Packed strict-TS consumer passed: MVC, Live, DI metadata, guards, pipe, recoverable sync validation, policy, replay and Node-safe client import.',
  );
} finally {
  await app.close();
  await renderer.dispose();
}

// Optional engine tarballs: each renders an escaped Nest/Live view and runs a
// Live counter action from the external install, without the HBS umbrella.
const engineRoot = await mkdtemp(join(tmpdir(), 'nestvexa-pack-engines-'));
try {
  const sources: Readonly<Record<string, string>> = {
    'check.ejs': '<p><%= text %></p><%= html %>',
    'check.pug': 'p= text\n= html',
    'check.njk': '<p>{{ text }}</p>{{ html }}',
    'engine-counter.ejs': '<output><%= count %></output>',
    'engine-counter.pug': 'output= count',
    'engine-counter.njk': '<output>{{ count }}</output>',
  };
  for (const [name, source] of Object.entries(sources))
    await writeFile(join(engineRoot, name), source);
  const engines: ViewEngineAdapter[] = [
    new EjsEngine({ root: engineRoot }),
    new PugEngine({ root: engineRoot }),
    new NunjucksEngine({ root: engineRoot, cache: true }),
  ];
  const registry = new ViewEngineRegistry();
  for (const engine of engines) registry.register(engine);
  await registry.initialize();
  try {
    for (const engine of engines) {
      registry.requireAll(engine.name, ['layouts', 'partials', 'safeHtml']);
      assert.throws(
        () => registry.require(engine.name, 'streaming'),
        /does not support streaming/,
      );
      assert.equal(
        await engine.render('check', {
          text: '<x>',
          html: SafeHtml.trusted('<b>ok</b>'),
        }),
        '<p>&lt;x&gt;</p><b>ok</b>',
      );
      @LiveComponent({ name: 'engine-counter', view: 'engine-counter' })
      class EngineCounter {
        @State() count = 0;
        @Action() increment(): void {
          this.count++;
        }
      }
      @Controller()
      class EngineHost {
        constructor(private readonly live: LiveRuntime) {}
        @Get()
        async mount(@Req() request: object) {
          return {
            html: (await this.live.mount(EngineCounter, request)).value,
          };
        }
      }
      @Module({
        imports: [
          LiveModule.register({
            components: [EngineCounter],
            renderer: engine,
            origin,
            resolveIdentity: () => ({
              binding: 'packed-engine/session/principal',
              csrfToken: csrf,
            }),
            authorize: (_identity, component, action) =>
              component === 'engine-counter' &&
              ['$mount', 'increment'].includes(action),
          }),
        ],
        controllers: [EngineHost],
      })
      class EngineApp {}
      const engineApp = await NestFactory.create(EngineApp, { logger: false });
      try {
        await engineApp.listen(0, '127.0.0.1');
        const engineBase = await engineApp.getUrl();
        const mounted = record(await (await fetch(engineBase)).json());
        const html = String(mounted['html']);
        assert.ok(html.includes('<output>0</output></div>'), engine.name);
        const engineSnapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
        assert.ok(engineSnapshot);
        const action = await fetch(
          `${engineBase}/_nestvexa/live/engine-counter/increment`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              origin,
              'x-nestvexa-csrf': csrf,
            },
            body: JSON.stringify({
              protocol: 'nestvexa-live/1',
              requestId: randomUUID(),
              snapshot: engineSnapshot,
              revision: 0,
              updates: {},
              input: null,
            }),
          },
        );
        assert.equal(action.status, 201, engine.name);
        assert.equal(
          record(await action.json())['html'],
          '<output>1</output>',
          engine.name,
        );
      } finally {
        await engineApp.close();
      }
    }
  } finally {
    await registry.dispose();
  }
  console.log(
    'Packed optional engines passed: EJS, Pug and Nunjucks escaped rendering, SafeHtml, capability checks and Live counter actions.',
  );
} finally {
  await rm(engineRoot, { recursive: true, force: true });
}
