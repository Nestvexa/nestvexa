import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Cache, MemoryCacheStore } from '../packages/cache/dist/index.js';
import {
  InertiaConfigurationError,
  InertiaModule,
  InertiaPage,
  defer,
} from '../packages/inertia/dist/index.js';
import {
  DevtoolsInspector,
  DevtoolsModule,
  MemoryInstrumentation,
  devtoolsSnapshot,
  renderDevtools,
  runWithRequestId,
} from '../packages/observability/dist/index.js';
import type { DevtoolsSnapshot } from '../packages/observability/dist/index.js';
import { closeAll, inertiaHeaders, json, send } from './inertia-support.js';

// DX-033: cache hit/miss from @nestvexa/cache `onEvent` and Inertia page
// props (redacted) in the development panel, both wired structurally (the
// observability package imports neither package).

describe('cache events in the development panel', () => {
  it('counts hits and misses per namespace with the request id and no keys or values', async () => {
    const inspector = new DevtoolsInspector({ environment: 'test' });
    let now = 1_000;
    const cache = new Cache({
      store: new MemoryCacheStore(10, () => now),
      now: () => now,
      onEvent: (event) => inspector.cacheEvent(event),
    });
    const scope = {
      kind: 'private',
      binding: 'session:cache-private-binding',
    } as const;
    const compute = () => ({ total: 'value-secret-42' });
    await runWithRequestId('request-cache-0001', async () => {
      await cache.get(
        { scope, namespace: 'data:orders', vary: { page: 1 } },
        { ttlMs: 1_000, tags: ['orders', 'user:7'] },
        compute,
      );
      await cache.get(
        { scope, namespace: 'data:orders', vary: { page: 1 } },
        { ttlMs: 1_000, tags: ['orders', 'user:7'] },
        compute,
      );
      await cache.get(
        { scope: { kind: 'public' }, namespace: 'data:stats' },
        { ttlMs: 1_000 },
        () => 1,
      );
    });
    now += 5_000;
    await cache.get(
      { scope, namespace: 'data:orders', vary: { page: 1 } },
      { ttlMs: 1_000, tags: ['orders'] },
      compute,
    );
    await cache.invalidate(['orders']);
    expect(inspector.cacheSummary).toEqual([
      {
        namespace: 'data:orders',
        hits: 1,
        misses: 2,
        stale: 0,
        coalesced: 0,
        bypassed: 0,
        errors: 0,
        hitRatio: 0.333,
      },
      {
        namespace: 'data:stats',
        hits: 0,
        misses: 1,
        stale: 0,
        coalesced: 0,
        bypassed: 0,
        errors: 0,
        hitRatio: 0,
      },
    ]);
    const events = inspector.cacheEvents;
    expect(events.map((event) => event.type)).toEqual([
      'invalidate',
      'miss',
      'miss',
      'hit',
      'miss',
    ]);
    expect(events[0]).toMatchObject({ tags: ['orders'], removed: 1 });
    expect(events[4]).toMatchObject({
      requestId: 'request-cache-0001',
      namespace: 'data:orders',
      scope: 'private',
    });
    expect(events[1]?.requestId).toBeUndefined();
    const snapshot = devtoolsSnapshot(
      new MemoryInstrumentation(),
      inspector,
      () => new Date(0),
    );
    expect(snapshot.cache.summary).toHaveLength(2);
    const html = renderDevtools(snapshot);
    expect(html).toContain('<code>data:orders</code>');
    expect(html).toContain('<td>1</td><td>2</td>');
    expect(html).toContain('33%');
    const serialized = JSON.stringify(snapshot) + html;
    for (const secret of ['value-secret-42', 'cache-private-binding'])
      expect(serialized).not.toContain(secret);
  });

  it('drops malformed events and bounds what it keeps', () => {
    const inspector = new DevtoolsInspector({
      environment: 'test',
      capacity: 3,
    });
    for (const event of [
      { type: 'evil' },
      { type: 'hit', namespace: 'Bad Namespace<script>' },
      { type: 'miss', namespace: 'data:x', tags: ['ok', '<b>', 7], scope: '!' },
      {
        type: 'store-error',
        namespace: 'data:x',
        reason: 'get',
        durationMs: -1,
      },
      { type: 'refused', namespace: 'data:x', reason: 'Not A Reason' },
      null,
    ])
      inspector.cacheEvent(event as never);
    const events = inspector.cacheEvents;
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.type)).toEqual([
      'refused',
      'store-error',
      'miss',
    ]);
    expect(events[0]?.reason).toBeUndefined();
    expect(events[1]).toMatchObject({ reason: 'get' });
    expect(events[1]?.durationMs).toBeUndefined();
    expect(events[2]).toMatchObject({ tags: ['ok'] });
    expect(events[2]?.scope).toBeUndefined();
    expect(JSON.stringify(events)).not.toContain('script');
    expect(inspector.cacheSummary).toEqual([
      expect.objectContaining({ namespace: 'data:x', misses: 1, errors: 1 }),
    ]);
    inspector.clear();
    expect(inspector.cacheEvents).toEqual([]);
    expect(inspector.cacheSummary).toEqual([]);
  });
});

@Controller()
class PagesController {
  @Get('account')
  @InertiaPage('Account/Show')
  account() {
    return {
      user: { name: 'Ada', password: 'hunter2-page-secret' },
      apiToken: 'tok-page-secret',
      note: '<script>alert(1)</script>',
      stats: defer(() => ({ visits: 3 })),
    };
  }
  @Get('broken')
  @InertiaPage('Broken')
  broken() {
    return { title: 'Still served' };
  }
}

describe('Inertia page props in the development panel', () => {
  const inspector = new DevtoolsInspector({ environment: 'test' });
  let app: INestApplication;
  let failing: INestApplication;
  beforeAll(async () => {
    const memory = new MemoryInstrumentation();
    const module = await Test.createTestingModule({
      imports: [
        InertiaModule.forRoot({
          version: 'v1',
          share: () => ({ appName: 'Demo', csrfToken: 'csrf-page-secret' }),
          inspector,
        }),
        DevtoolsModule.register({
          instrumentation: memory,
          inspector,
          authorize: () => true,
          environment: 'test',
        }),
      ],
      controllers: [PagesController],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    const broken = await Test.createTestingModule({
      imports: [
        InertiaModule.forRoot({
          version: 'v1',
          inspector: {
            page() {
              throw new Error('inspector failure');
            },
          },
        }),
      ],
      controllers: [PagesController],
    }).compile();
    failing = broken.createNestApplication({ logger: false });
    await failing.listen(0, '127.0.0.1');
  });
  afterEach(() => inspector.clear());
  afterAll(async () => {
    await app.close();
    await failing.close();
    await closeAll();
  });

  it('records each page response with redacted props, deferred and shared names', async () => {
    const result = await send(app, '/account', {
      headers: inertiaHeaders('v1'),
    });
    expect(result.status).toBe(200);
    // The browser still receives the real props; only the panel copy is redacted.
    expect(json(result)['props']).toMatchObject({
      apiToken: 'tok-page-secret',
    });
    const [page] = inspector.pages;
    expect(page).toMatchObject({
      component: 'Account/Show',
      kind: 'json',
      status: 200,
      deferred: ['stats'],
      props: {
        apiToken: '[redacted]',
        csrfToken: '[redacted]',
        user: { name: 'Ada', password: '[redacted]' },
        note: '<script>alert(1)</script>',
      },
    });
    expect(page?.propNames).toEqual(
      expect.arrayContaining(['user', 'apiToken', 'appName', 'errors']),
    );
    expect(page?.shared).toEqual(
      expect.arrayContaining(['appName', 'csrfToken']),
    );
    expect(page?.partial).toBeUndefined();
    const data = json(
      await send(app, '/_nestvexa/devtools/data.json'),
    ) as unknown as DevtoolsSnapshot;
    expect(data.pages[0]?.component).toBe('Account/Show');
    const html = (await send(app, '/_nestvexa/devtools')).body;
    expect(html).toContain('Inertia pages');
    expect(html).toContain('<code>Account/Show</code>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toMatch(/<script/i);
    const serialized = JSON.stringify(data) + html;
    for (const secret of [
      'hunter2-page-secret',
      'tok-page-secret',
      'csrf-page-secret',
    ])
      expect(serialized).not.toContain(secret);
  });

  it('marks partial reloads with the requested prop names', async () => {
    await send(app, '/account', {
      headers: {
        ...inertiaHeaders('v1'),
        'x-inertia-partial-component': 'Account/Show',
        'x-inertia-partial-data': 'stats',
      },
    });
    expect(inspector.pages[0]).toMatchObject({
      component: 'Account/Show',
      partial: ['stats'],
      props: { stats: { visits: 3 } },
    });
  });

  it('never lets a failing inspector change the response and validates the option', async () => {
    const result = await send(failing, '/broken', {
      headers: inertiaHeaders('v1'),
    });
    expect(result.status).toBe(200);
    expect(json(result)['props']).toMatchObject({ title: 'Still served' });
    expect(() => InertiaModule.forRoot({ inspector: {} as never })).toThrow(
      InertiaConfigurationError,
    );
  });

  it('bounds stored props and ignores invalid page input', () => {
    const small = new DevtoolsInspector({
      environment: 'test',
      maxStateBytes: 64,
      capacity: 2,
    });
    small.page({
      component: 'Big',
      kind: 'document',
      props: { rows: 'x'.repeat(500) },
    });
    expect(small.pages[0]).toMatchObject({
      component: 'Big',
      kind: 'document',
      status: 200,
      propNames: ['rows'],
    });
    expect(small.pages[0]?.props).toEqual({ '[elided]': expect.any(String) });
    small.page({ component: '<script>', kind: 'json', props: {} });
    small.page({ component: 'Other', kind: 'json', props: [] as never });
    small.page({ component: 'Third', kind: 'json', props: {}, status: 99 });
    expect(small.pages.map((page) => page.component)).toEqual([
      'Third',
      'Other',
    ]);
    expect(small.pages[0]?.status).toBe(200);
    expect(small.pages[1]?.props).toEqual({});
  });
});
