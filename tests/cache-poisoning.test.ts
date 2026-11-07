import 'reflect-metadata';
import { Controller, Get } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import fc from 'fast-check';
import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  Cache,
  MemoryCacheStore,
  cacheKey,
} from '../packages/cache/dist/index.js';
import type { CacheKeyParts } from '../packages/cache/dist/index.js';
import {
  InertiaModule,
  InertiaPage,
  defer,
  optional,
} from '../packages/inertia/dist/index.js';
import {
  NestvexaAssetsModule,
  NestvexaAssetsService,
} from '../packages/nestvexa/dist/assets.js';
import { viteStaticMiddleware } from '../packages/vite/dist/index.js';

// SEC-030: cache poisoning and request-coalescing leaks.
// 1. Headers a shared cache does not key on (X-Forwarded-*, X-Original-URL,
//    method overrides, Forwarded) never change a cacheable response.
// 2. Inertia JSON page responses list every content-selecting request header
//    in Vary, so a partial reload cannot be replayed to full visits.
// 3. @nestvexa/cache single-flight never shares a value, error or object
//    between private identities or tenants.

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
function send(
  base: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const url = new URL(path, base);
  return new Promise((done, reject) => {
    const outgoing = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        headers: { connection: 'close', ...headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          done({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/** Headers commonly left out of shared-cache keys, with hostile values. */
const unkeyed: Readonly<Record<string, string>> = {
  'x-forwarded-host': 'evil.example',
  'x-forwarded-proto': 'http',
  'x-forwarded-port': '8443',
  'x-forwarded-prefix': '/evil',
  'x-forwarded-server': 'evil.example',
  'x-host': 'evil.example',
  'x-original-url': '/admin',
  'x-rewrite-url': '/admin',
  'x-http-method-override': 'DELETE',
  'x-method-override': 'DELETE',
  forwarded: 'for=1.2.3.4;host=evil.example;proto=http',
  'x-original-host': 'evil.example',
};

/** The cache-relevant view of a response. */
function cacheable(reply: Reply): Record<string, unknown> {
  const keep = [
    'content-type',
    'content-length',
    'cache-control',
    'etag',
    'vary',
    'location',
    'x-inertia',
    'x-inertia-location',
    'content-security-policy',
  ];
  return {
    status: reply.status,
    body: reply.body,
    headers: Object.fromEntries(
      keep
        .filter((name) => reply.headers[name] !== undefined)
        .map((name) => [name, reply.headers[name]]),
    ),
  };
}

async function unchangedByUnkeyedHeaders(
  base: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<void> {
  const baseline = cacheable(await send(base, path, headers));
  for (const [name, value] of Object.entries(unkeyed))
    expect(
      cacheable(await send(base, path, { ...headers, [name]: value })),
      `${name} changed ${path}`,
    ).toStrictEqual(baseline);
  expect(
    cacheable(await send(base, path, { ...headers, ...unkeyed })),
  ).toStrictEqual(baseline);
}

/**
 * Minimal shared cache: keys on the URL plus the request values of every
 * header the stored response lists in Vary (RFC 9111 §4.1).
 */
class SharedCache {
  readonly #entries = new Map<string, { vary: string[]; reply: Reply }[]>();
  lookup(path: string, headers: Record<string, string>): Reply | undefined {
    return this.#entries
      .get(path)
      ?.find((entry) =>
        entry.vary.every(
          (name) =>
            (headers[name] ?? '') ===
            (entry.reply.headers[`req:${name}`] ?? ''),
        ),
      )?.reply;
  }
  store(path: string, headers: Record<string, string>, reply: Reply): void {
    const vary = String(reply.headers['vary'] ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    const remembered: Record<string, string> = {};
    for (const name of vary) remembered[`req:${name}`] = headers[name] ?? '';
    const entry = {
      vary,
      reply: { ...reply, headers: { ...reply.headers, ...remembered } },
    };
    this.#entries.set(path, [...(this.#entries.get(path) ?? []), entry]);
  }
}

@Controller()
class CatalogController {
  @Get('catalog')
  @InertiaPage('Catalog')
  catalog() {
    return {
      products: ['mug', 'shirt'],
      reviews: defer(() => ['great']),
      related: optional(() => ['hat']),
    };
  }
}

const apps: INestApplication[] = [];
afterAll(async () => {
  for (const app of apps.splice(0)) await app.close();
});

describe.each(['express', 'fastify'] as const)(
  'Inertia responses on %s',
  (platform) => {
    let base: string;
    beforeAll(async () => {
      const module = await Test.createTestingModule({
        imports: [InertiaModule.forRoot({ version: 'v1' })],
        controllers: [CatalogController],
      }).compile();
      const app =
        platform === 'fastify'
          ? module.createNestApplication(new FastifyAdapter(), {
              logger: false,
            })
          : module.createNestApplication({ logger: false });
      apps.push(app);
      await app.listen(0, '127.0.0.1');
      base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    });
    const inertia = { 'x-inertia': 'true', 'x-inertia-version': 'v1' };

    it('ignores unkeyed forwarding and override headers in documents, JSON and 409s', async () => {
      await unchangedByUnkeyedHeaders(base, '/catalog');
      await unchangedByUnkeyedHeaders(base, '/catalog', inertia);
      await unchangedByUnkeyedHeaders(base, '/catalog?page=2', {
        'x-inertia': 'true',
        'x-inertia-version': 'stale',
      });
    });

    it('lists every content-selecting header in Vary on JSON page responses', async () => {
      const reply = await send(base, '/catalog', inertia);
      const vary = String(reply.headers['vary'])
        .split(',')
        .map((name) => name.trim().toLowerCase());
      expect(vary).toEqual(
        expect.arrayContaining([
          'x-inertia',
          'x-inertia-version',
          'x-inertia-partial-component',
          'x-inertia-partial-data',
          'x-inertia-partial-except',
          'x-inertia-reset',
          'x-inertia-error-bag',
          'x-inertia-infinite-scroll-merge-intent',
          'x-inertia-except-once-props',
        ]),
      );
      const document = await send(base, '/catalog');
      expect(document.headers['vary']).toBe('X-Inertia');
      const conflict = await send(base, '/catalog', {
        'x-inertia': 'true',
        'x-inertia-version': 'stale',
      });
      expect(conflict.status).toBe(409);
      expect(conflict.headers['vary']).toBe('X-Inertia, X-Inertia-Version');
    });

    it('a cached partial reload is never served to a full Inertia visit', async () => {
      const cache = new SharedCache();
      // Attacker primes the shared cache with a partial reload that selects
      // only a prop that does not exist (an empty page for everyone else).
      const attacker = {
        ...inertia,
        'x-inertia-partial-component': 'Catalog',
        'x-inertia-partial-data': 'nothing',
      };
      const poisoned = await send(base, '/catalog', attacker);
      expect(
        (JSON.parse(poisoned.body) as { props: object }).props,
      ).toStrictEqual({ errors: {} });
      cache.store('/catalog', attacker, poisoned);
      // Victim: a normal Inertia visit and a partial reload of another prop.
      expect(cache.lookup('/catalog', inertia)).toBeUndefined();
      expect(
        cache.lookup('/catalog', {
          ...inertia,
          'x-inertia-partial-component': 'Catalog',
          'x-inertia-partial-data': 'reviews',
        }),
      ).toBeUndefined();
      // The attacker's exact request may still hit its own entry.
      expect(cache.lookup('/catalog', attacker)?.body).toBe(poisoned.body);
      // Documents are keyed on X-Inertia: a cached JSON reply is never served
      // as the HTML document.
      expect(cache.lookup('/catalog', {})).toBeUndefined();
    });
  },
);

describe.each(['express', 'fastify'] as const)(
  'client asset host on %s',
  (platform) => {
    it('serves identical immutable assets whatever unkeyed headers say', async () => {
      const module = await Test.createTestingModule({
        imports: [NestvexaAssetsModule.register({})],
      }).compile();
      const app =
        platform === 'fastify'
          ? module.createNestApplication(new FastifyAdapter(), {
              logger: false,
            })
          : module.createNestApplication({ logger: false });
      apps.push(app);
      await app.listen(0, '127.0.0.1');
      const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
      const manifest = app.get(NestvexaAssetsService).getManifest();
      const path = `/_nestvexa/assets/${manifest.version}/index.js`;
      const reply = await send(base, path);
      expect(reply.status).toBe(200);
      expect(reply.headers['cache-control']).toMatch(/immutable/);
      await unchangedByUnkeyedHeaders(base, path);
      await unchangedByUnkeyedHeaders(base, '/_nestvexa/assets/old/index.js');
    });
  },
);

describe('Vite static middleware', () => {
  let server: Server;
  let base: string;
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'nestvexa-poison-static-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'app-Ab12Cd34.js'), 'export {};\n');
    await writeFile(join(root, 'robots.txt'), 'User-agent: *\n');
    const middleware = viteStaticMiddleware({ root, prefix: '/build/' });
    server = createServer((request, response) =>
      middleware(request, response, () => response.writeHead(404).end('none')),
    );
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No port');
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Unexpected fixture directory');
    await rm(root, { recursive: true, force: true });
  });

  it('ignores unkeyed headers for hashed, plain and missing files', async () => {
    const hashed = await send(base, '/build/assets/app-Ab12Cd34.js');
    expect(hashed.status).toBe(200);
    await unchangedByUnkeyedHeaders(base, '/build/assets/app-Ab12Cd34.js');
    await unchangedByUnkeyedHeaders(base, '/build/robots.txt');
    await unchangedByUnkeyedHeaders(base, '/build/assets/missing.js');
  });
});

describe('@nestvexa/cache single-flight across identities', () => {
  const alice = 'session:alice:0123456789abcdef';
  const bob = 'session:bob:0123456789abcdef00';
  const parts = (binding: string, tenant?: string): CacheKeyParts => ({
    scope: {
      kind: 'private',
      binding,
      ...(tenant === undefined ? {} : { tenant }),
    },
    namespace: 'data:dashboard',
    vary: { locale: 'en' },
  });
  let store: MemoryCacheStore;
  let cache: Cache;
  afterEach(() => store.clear());
  function setup(): void {
    store = new MemoryCacheStore();
    cache = new Cache(store);
  }

  it('computes once per identity under concurrency and never hands one identity another’s value', async () => {
    setup();
    const computed: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => (release = done));
    const load = (binding: string) =>
      cache.get(parts(binding), { ttlMs: 60_000 }, async () => {
        computed.push(binding);
        await gate;
        return { owner: binding, balance: binding === alice ? 100 : 7 };
      });
    const pending = Array.from({ length: 20 }, (_, index) =>
      load(index % 2 ? alice : bob),
    );
    release();
    const results = await Promise.all(pending);
    results.forEach((result, index) =>
      expect(result.owner).toBe(index % 2 ? alice : bob),
    );
    expect(computed.sort()).toEqual([alice, bob].sort());
    expect(cache.metrics.coalesced).toBe(18);
    // Later reads hit each identity's own entry.
    expect((await load(bob)).balance).toBe(7);
    expect((await load(alice)).balance).toBe(100);
  });

  it('separates the same binding in different tenants and public from private', async () => {
    setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => (release = done));
    const runs: string[] = [];
    const compute = (label: string) => async () => {
      runs.push(label);
      await gate;
      return label;
    };
    const pending = [
      cache.get(parts(alice, 'tenant-a'), { ttlMs: 1000 }, compute('a')),
      cache.get(parts(alice, 'tenant-b'), { ttlMs: 1000 }, compute('b')),
      cache.get(parts(alice), { ttlMs: 1000 }, compute('none')),
      cache.get(
        {
          scope: { kind: 'public' },
          namespace: 'data:dashboard',
          vary: { locale: 'en' },
        },
        { ttlMs: 1000 },
        compute('public'),
      ),
    ];
    release();
    expect(await Promise.all(pending)).toEqual(['a', 'b', 'none', 'public']);
    expect(runs).toEqual(['a', 'b', 'none', 'public']);
    expect(cache.metrics.coalesced).toBe(0);
  });

  it('does not propagate one identity’s failure to another identity’s request', async () => {
    setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => (release = done));
    const failing = cache.get(parts(alice), { ttlMs: 1000 }, async () => {
      await gate;
      throw new Error('alice-only failure: account locked');
    });
    const coalescedFailure = cache.get(
      parts(alice),
      { ttlMs: 1000 },
      () => 'x',
    );
    const other = cache.get(parts(bob), { ttlMs: 1000 }, async () => {
      await gate;
      return 'bob-value';
    });
    release();
    await expect(failing).rejects.toThrow(/alice-only/);
    await expect(coalescedFailure).rejects.toThrow(/alice-only/);
    await expect(other).resolves.toBe('bob-value');
    // A failure is not cached: the next call computes again.
    await expect(
      cache.get(parts(alice), { ttlMs: 1000 }, () => 'recovered'),
    ).resolves.toBe('recovered');
  });

  it('gives every coalesced caller a private copy', async () => {
    setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((done) => (release = done));
    const compute = async () => {
      await gate;
      return { items: ['a'] };
    };
    const [first, second] = await Promise.all([
      cache.get(parts(alice), { ttlMs: 1000 }, compute),
      cache.get(parts(alice), { ttlMs: 1000 }, compute),
      Promise.resolve().then(release),
    ]);
    expect(first).not.toBe(second);
    first?.items.push('tampered');
    expect(second?.items).toEqual(['a']);
    expect(
      (await cache.get(parts(alice), { ttlMs: 1000 }, compute)).items,
    ).toEqual(['a']);
  });

  it('refuses stale-while-revalidate for private entries', async () => {
    setup();
    await expect(
      cache.get(
        parts(alice),
        { ttlMs: 1000, staleWhileRevalidateMs: 1000 },
        () => 1,
      ),
    ).rejects.toThrow(/public/);
  });

  it('refuses bindings with unpaired surrogates, which UTF-8 hashing would merge', () => {
    // Regression: these bindings used to hash to one key (both become U+FFFD).
    for (const binding of [
      `${alice}\uD800`,
      `${alice}\uDBFF`,
      `\uDC00${alice}`,
    ])
      expect(() => cacheKey(parts(binding))).toThrow(/well-formed/);
    // Paired surrogates (astral characters) and a literal U+FFFD stay valid
    // and distinct.
    expect(cacheKey(parts(`${alice}\u{1F600}`))).not.toBe(
      cacheKey(parts(`${alice}�`)),
    );
  });

  it('derives distinct keys for distinct identities, tenants and vary values', () => {
    const tenant = fc.option(fc.stringMatching(/^[a-z][a-z0-9:._-]{0,20}$/), {
      nil: undefined,
    });
    // Arbitrary UTF-16 code units, including unpaired surrogates and newlines.
    const binding = fc.string({
      minLength: 16,
      maxLength: 40,
      unit: fc.oneof(
        fc
          .integer({ min: 0, max: 0xffff })
          .map((unit) => String.fromCharCode(unit)),
        fc.constantFrom('\n', '�', '\uD800', 'a'),
      ),
    });
    const key = (b: string, t: string | undefined): string | undefined => {
      try {
        return cacheKey(parts(b, t));
      } catch {
        return undefined;
      }
    };
    fc.assert(
      fc.property(binding, tenant, binding, tenant, (b1, t1, b2, t2) => {
        fc.pre(b1 !== b2 || t1 !== t2);
        const left = key(b1, t1);
        const right = key(b2, t2);
        if (left !== undefined && right !== undefined)
          expect(left).not.toBe(right);
      }),
      { numRuns: 1000 },
    );
    const vary = fc.dictionary(
      fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,6}$/),
      fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.constant(null)),
      { maxKeys: 4 },
    );
    fc.assert(
      fc.property(vary, vary, (left, right) => {
        const key = (values: typeof left) =>
          cacheKey({
            scope: { kind: 'public' },
            namespace: 'render:x',
            vary: values,
          });
        const same =
          JSON.stringify(Object.entries(left).sort()) ===
          JSON.stringify(Object.entries(right).sort());
        if (same) expect(key(left)).toBe(key(right));
        else expect(key(left)).not.toBe(key(right));
      }),
      { numRuns: 500 },
    );
  });
});
