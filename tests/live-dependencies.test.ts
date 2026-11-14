/**
 * REAL-010: explicit `@DependsOn` data tags with conservative invalidation.
 * A `Cache` from @nestvexa/cache is wired to `LiveTags.listener` (structural
 * `onInvalidate`), so `cache.invalidate(tags)` publishes on `tag:<tag>`
 * through the real `RealtimeService`. Only SSE subscriptions whose signed
 * token covers that tag receive it; the dependent component's read-only
 * refresh then renders the recomputed value, and unrelated components get
 * nothing. Express and Fastify.
 */
import 'reflect-metadata';
import { Inject, Injectable, Module } from '@nestjs/common';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Cache, MemoryCacheStore } from '../packages/cache/dist/index.js';
import {
  DependsOn,
  LiveComponent,
  LiveModule,
  LiveRuntime,
  LiveTags,
  RealtimeChannels,
  State,
  Computed,
  liveTagChannel,
} from '../packages/live/dist/index.js';
import { definition } from '../packages/live/dist/metadata.js';
import {
  RealtimeModule,
  RealtimeService,
} from '../packages/realtime/dist/index.js';
import {
  application,
  cleanup,
  envelope,
  marker,
  origin,
  platforms,
  policies,
  renderer,
  send,
} from './support/live-fixture.js';

afterEach(cleanup);

const binding = 'live-fixture/session/principal';
const secret = 'live-dependencies-secret-0123456789abcdef';
/** Database stand-in. */
const db = { orders: [1], invoices: [1] };
/** Cache shared by components; wired to LiveTags once the app exists. */
const cacheSlot: { cache?: Cache } = {};
let computeCount = 0;

@Injectable()
class Orders {
  async total(): Promise<number> {
    const cache = cacheSlot.cache;
    if (!cache) throw new Error('cache not wired');
    return cache.get(
      { scope: { kind: 'public' }, namespace: 'data:orders' },
      { ttlMs: 60_000, tags: ['orders:tenant-a'] },
      () => {
        computeCount++;
        return db.orders.length;
      },
    );
  }
}

@Module({ providers: [Orders], exports: [Orders] })
class OrdersModule {}

@DependsOn('orders:tenant-a')
@LiveComponent({ name: 'orders-panel', view: 'orders-panel' })
class OrdersPanel {
  constructor(@Inject(Orders) private readonly orders: Orders) {}
  @State() region = 'eu';
  /** Read through the cache on every render: a refresh stays read-only. */
  @Computed({ async: true }) async total(): Promise<number> {
    return this.orders.total();
  }
}

@DependsOn<InvoicesPanel>((panel) => [`invoices:${panel.tenant}`])
@LiveComponent({ name: 'invoices-panel', view: 'invoices-panel' })
class InvoicesPanel {
  @State() tenant = 'tenant-a';
  @State() total = 0;
  dehydrate(): void {
    this.total = db.invoices.length;
  }
}

/** Declares channels and a tag: both are signed into one token. */
@DependsOn('orders:tenant-a')
@LiveComponent({ name: 'mixed-panel', view: 'plain-panel' })
class MixedPanel {
  @State() label = 'mixed';
  @RealtimeChannels() channels(): string[] {
    return ['board:public'];
  }
}

@LiveComponent({ name: 'plain-panel', view: 'plain-panel' })
class PlainPanel {
  @State() label = 'plain';
}

interface Stream {
  readonly read: () => string;
  readonly close: () => void;
}
function stream(url: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    let text = '';
    const request = httpRequest(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`SSE status ${response.statusCode ?? 0}`));
        return;
      }
      response.on('data', (chunk: Buffer) => (text += chunk.toString()));
      resolve({ read: () => text, close: () => request.destroy() });
    });
    request.on('error', (error) => (text ? undefined : reject(error)));
    request.end();
  });
}
async function until(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const token = (html: string) =>
  /data-nv-realtime="([^"]+)"/.exec(html)?.[1] ?? '';

describe('@DependsOn metadata', () => {
  it('records static tags and tag functions', () => {
    expect(definition(OrdersPanel).dependencies).toEqual(['orders:tenant-a']);
    expect(definition(InvoicesPanel).dependencies).toHaveLength(1);
    expect(definition(PlainPanel).dependencies).toBeUndefined();
  });

  it('rejects invalid declarations at decoration time', () => {
    for (const bad of ['', 'Orders', 'has space', `x${'a'.repeat(124)}`])
      expect(() => DependsOn(bad), bad).toThrow(/Dependency tags/);
    expect(() => DependsOn()).toThrow(/1-32/);
    expect(() =>
      DependsOn(...Array.from({ length: 33 }, (_, index) => `t${index}`)),
    ).toThrow(/1-32/);
    expect(() => DependsOn(7 as unknown as string)).toThrow(/tags or tag/);
    class Twice {}
    DependsOn('a')(Twice);
    expect(() => DependsOn('b')(Twice)).toThrow(/Only one/);
  });

  it('maps tags to the cache tag channel grammar', () => {
    expect(liveTagChannel('orders:tenant-a')).toBe('tag:orders:tenant-a');
    expect(() => liveTagChannel('Bad')).toThrow();
  });
});

describe.each(platforms)('tag invalidation end to end: %s', (platform) => {
  async function fixture() {
    db.orders = [1];
    db.invoices = [1];
    computeCount = 0;
    const { engine, module, resource } = await renderer({
      'orders-panel': '<p>orders={{total}}</p>',
      'invoices-panel': '<p>invoices={{total}}</p>',
      'plain-panel': '<p>{{label}}</p>',
    });
    const app = await application(
      platform,
      [
        RealtimeModule.forRoot({
          secrets: [secret],
          origin,
          resolveIdentity: () => ({ binding }),
          // The policy, not the tag, decides who may read a tag channel.
          authorizeChannel: (_identity, channel) =>
            channel.startsWith('tag:') || channel === 'board:public',
        }),
        LiveModule.registerAsync({
          components: [OrdersPanel, InvoicesPanel, MixedPanel, PlainPanel],
          imports: [module, OrdersModule],
          inject: [RealtimeService],
          useFactory: (realtime: RealtimeService) => ({
            ...policies(engine),
            realtime,
          }),
        }),
      ],
      [],
      resource,
    );
    const tags = app.get(LiveTags);
    const published: string[] = [];
    const realtime = app.get(RealtimeService);
    const publish = realtime.publish.bind(realtime);
    realtime.publish = (async (...args: Parameters<typeof publish>) => {
      published.push(args[0]);
      return publish(...args);
    }) as typeof realtime.publish;
    cacheSlot.cache = new Cache(
      new MemoryCacheStore(),
      Date.now,
      tags.listener,
    );
    const runtime = app.get(LiveRuntime);
    const base = await app.getUrl();
    const streams: Stream[] = [];
    const open = async (html: string) => {
      const opened = await stream(
        `${base}/_nestvexa/realtime/sse?t=${encodeURIComponent(token(html))}`,
      );
      streams.push(opened);
      await until(() => opened.read().includes('event: ready'), 'ready');
      return opened;
    };
    const mount = async (type: Parameters<LiveRuntime['mount']>[0]) =>
      (await runtime.mount(type, { headers: {} })).value;
    const refresh = (name: string, html: string) =>
      send(app, `/_nestvexa/live/${name}/_sync`, envelope(marker(html)), {
        'x-nestvexa-resync': '1',
      });
    return {
      app,
      tags,
      realtime,
      published,
      open,
      mount,
      refresh,
      close: () => {
        for (const opened of streams) opened.close();
      },
    };
  }

  it('signs tag channels and leaves undeclared components unsubscribed', async () => {
    const f = await fixture();
    try {
      const orders = await f.mount(OrdersPanel);
      const invoices = await f.mount(InvoicesPanel);
      const mixed = await f.mount(MixedPanel);
      const plain = await f.mount(PlainPanel);
      const channels = (html: string) =>
        f.realtime.signer.verify(token(html), binding).channels;
      expect(channels(orders)).toEqual(['tag:orders:tenant-a']);
      expect(channels(invoices)).toEqual(['tag:invoices:tenant-a']);
      expect(channels(mixed)).toEqual(['board:public', 'tag:orders:tenant-a']);
      expect(token(plain)).toBe('');
    } finally {
      f.close();
    }
  });

  it('refreshes dependent components only after a cache invalidation', async () => {
    const f = await fixture();
    try {
      const ordersHtml = await f.mount(OrdersPanel);
      const invoicesHtml = await f.mount(InvoicesPanel);
      expect(ordersHtml).toContain('orders=1');
      expect(computeCount).toBe(1);
      const ordersStream = await f.open(ordersHtml);
      const invoicesStream = await f.open(invoicesHtml);
      // A write the cache still hides: the cached total stays 1.
      db.orders.push(2);
      db.invoices.push(2);
      const cached = await f.refresh('orders-panel', ordersHtml);
      expect(cached.json()['html']).toContain('orders=1');
      // The write path invalidates its tag: cache entry dropped, tag published.
      expect(await cacheSlot.cache?.invalidate(['orders:tenant-a'])).toBe(1);
      expect(f.published).toEqual(['tag:orders:tenant-a']);
      await until(
        () => ordersStream.read().includes('event: invalidate'),
        'orders invalidation',
      );
      expect(ordersStream.read()).toContain('"channel":"tag:orders:tenant-a"');
      // The dependent component's read-only refresh recomputes the value.
      const refreshed = await f.refresh('orders-panel', ordersHtml);
      expect(refreshed.status).toBe(201);
      expect(refreshed.json()).toMatchObject({
        component: { revision: marker(ordersHtml).revision },
        state: { region: 'eu' },
      });
      expect(refreshed.json()['html']).toContain('orders=2');
      expect(computeCount).toBe(2);
      // Unrelated subscriptions received nothing (give delivery a moment).
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(invoicesStream.read()).not.toContain('event: invalidate');
    } finally {
      f.close();
    }
  });

  it('publishes each distinct tag once and nothing for an invalid batch', async () => {
    const f = await fixture();
    try {
      await f.tags.invalidate(['invoices:tenant-a', 'invoices:tenant-a']);
      expect(f.published).toEqual(['tag:invoices:tenant-a']);
      await expect(
        f.tags.invalidate(['orders:tenant-a', 'Not A Tag']),
      ).rejects.toThrow(/Dependency tags/);
      await f.tags.invalidate([]);
      expect(f.published).toEqual(['tag:invoices:tenant-a']);
      expect(f.tags.enabled).toBe(true);
    } finally {
      f.close();
    }
  });
});

describe('LiveTags without a publisher', () => {
  it('fails clearly instead of dropping invalidations', async () => {
    const { engine, module, resource } = await renderer({
      'plain-panel': '<p>{{label}}</p>',
    });
    const app = await application(
      'express',
      [
        LiveModule.registerAsync({
          components: [PlainPanel],
          imports: [module],
          useFactory: () => policies(engine),
        }),
      ],
      [],
      resource,
    );
    const tags = app.get(LiveTags);
    expect(tags.enabled).toBe(false);
    await expect(tags.invalidate(['orders:tenant-a'])).rejects.toThrow(
      /publisher/,
    );
  });
});
