import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  Controller,
  Get,
  Module,
  Render,
  Req,
  VersioningType,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  Action,
  LiveComponent,
  LiveRuntime,
  NestvexaBrowserService,
  NestvexaModule,
  State,
  configureNestvexa,
} from 'nestvexa';
import { NestvexaAssetsService } from 'nestvexa/assets';

@LiveComponent({ name: 'default-counter', view: 'default-counter' })
class Counter {
  @State() count = 0;
  @Action() increment(): void {
    this.count++;
  }
}
@Controller()
class Home {
  constructor(private readonly live: LiveRuntime) {}
  @Get()
  @Render('default-home')
  async index(@Req() request: object) {
    return {
      message: '<unsafe>',
      widget: await this.live.mount(Counter, request),
    };
  }
  @Get('api/health') health() {
    return { status: 'ok' };
  }
}
const origin = 'http://localhost';
const csrf = 'minimal-packed-host-csrf-0123456789abcdef';
@Module({
  imports: [
    NestvexaModule.forRoot(
      {
        views: { root: 'views', layout: 'default-layout' },
        live: { enabled: true },
      },
      {
        components: [Counter],
        basePath: '/host',
        useFactory: () => ({
          origin,
          // Fixed identity is a hermetic packaging fixture, not an authentication starter.
          resolveIdentity: () => ({
            binding: 'minimal-packed-host-session',
            csrfToken: csrf,
          }),
          authorize: (_identity, component, action) =>
            component === 'default-counter' &&
            ['$mount', 'increment'].includes(action),
        }),
      },
    ),
  ],
  controllers: [Home],
})
class Host {}

const app = await NestFactory.create(Host, { logger: false });
try {
  await configureNestvexa(app);
  app.setGlobalPrefix('host');
  app.enableVersioning({
    type: VersioningType.HEADER,
    header: 'x-api-version',
    defaultVersion: '1',
  });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const page = await fetch(`${base}/host`, {
    headers: { 'x-api-version': '1' },
  });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('<h1>&lt;unsafe&gt;</h1>'));
  assert.ok(html.includes('<output>0</output>'));
  assert.ok(!html.includes('<h1><unsafe></h1>'));
  const browser = app.get(NestvexaBrowserService);
  assert.equal(browser.getBootUrl(), '/host/_nestvexa/boot.js');
  assert.ok(
    html.includes(
      '<script type="module" src="/host/_nestvexa/boot.js"></script>',
    ),
  );
  // Boot and assets remain version-neutral despite the host's versioned page/Live routes.
  const boot = await fetch(`${base}${browser.getBootUrl()}`);
  assert.equal(boot.status, 200);
  assert.equal(boot.headers.get('cache-control'), 'no-store');
  assert.match(boot.headers.get('content-type') ?? '', /^text\/javascript/);
  const bootstrap = await boot.text();
  assert.ok(bootstrap.includes('startLiveAlpine(Alpine, createLiveClient()'));
  const manifest = app.get(NestvexaAssetsService).getManifest();
  for (const url of Object.values(manifest.entries))
    assert.ok(bootstrap.includes(JSON.stringify(url)));
  assert.match(manifest.version, /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(manifest.files).length, 16);
  for (const [name, url] of Object.entries(manifest.files)) {
    const response = await fetch(`${base}${url}`);
    assert.equal(response.status, 200, name);
    assert.match(
      response.headers.get('content-type') ?? '',
      /^text\/javascript/,
    );
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const text = await response.text();
    assert.ok(text.length > 0, name);
    const etag = response.headers.get('etag');
    assert.ok(etag);
    const cached = await fetch(`${base}${url}`, {
      headers: { 'if-none-match': `W/${etag}` },
    });
    assert.equal(cached.status, 304, name);
    assert.equal(await cached.text(), '');
  }
  const unknown = await fetch(`${base}${manifest.entries.live}.map`);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get('cache-control'), 'no-store');
  assert.equal(
    (await fetch(`${base}${manifest.entries.live}`, { method: 'HEAD' })).status,
    200,
  );
  const snapshot = /data-nv-snapshot="([^"]+)"/.exec(html)?.[1];
  assert.ok(snapshot);
  assert.ok(
    html.includes('data-nv-endpoint="/host/_nestvexa/live/default-counter"'),
  );
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
    'x-api-version': '1',
    origin,
    'x-nestvexa-csrf': csrf,
  };
  const action = `${base}/host/_nestvexa/live/default-counter/increment`;
  const denied = await fetch(action, {
    method: 'POST',
    headers: { ...headers, 'x-nestvexa-csrf': 'forged' },
    body,
  });
  assert.equal(denied.status, 403);
  const updated = await fetch(action, { method: 'POST', headers, body });
  assert.equal(updated.status, 201);
  assert.equal(updated.headers.get('cache-control'), 'no-store');
  const result: unknown = await updated.json();
  assert.ok(typeof result === 'object' && result !== null);
  assert.ok('html' in result);
  // Live fragments use the same HBS engine, with document layouts explicitly disabled.
  assert.equal(result.html, '<output>1</output>');
  const replay = await fetch(action, { method: 'POST', headers, body });
  assert.equal(replay.status, 409);
  const health = await fetch(`${base}/host/api/health`, {
    headers: { 'x-api-version': '1' },
  });
  assert.deepEqual(await health.json(), { status: 'ok' });
  console.log(
    'Minimal umbrella-only install passed shared HBS layouts/escaping, Live action/CSRF/replay, native REST, default boot and all 16 version-neutral client/Alpine assets.',
  );
} finally {
  await app.close();
}
