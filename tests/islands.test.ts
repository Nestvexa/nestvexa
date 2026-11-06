import { describe, expect, it } from 'vitest';
import {
  IslandError,
  IslandRegistry,
  checkIslandProps,
  parseIslandManifest,
  serializeProps,
} from '../packages/islands/dist/index.js';
import { createIslandManifest } from '../packages/islands/dist/build.js';
import { SafeHtml } from '../packages/views/dist/index.js';

const registry = new IslandRegistry([
  { id: 'revenue-chart', framework: 'react', strategy: 'immediate' },
  { id: 'feed', framework: 'vue' },
  { id: 'tiny', framework: 'svelte', maxPropsBytes: 32 },
]);

describe('island registry', () => {
  it('rejects invalid, duplicate and unknown definitions', () => {
    expect(
      () => new IslandRegistry([{ id: 'Bad Id', framework: 'react' }]),
    ).toThrow(IslandError);
    expect(
      () =>
        new IslandRegistry([
          { id: 'a', framework: 'react' },
          { id: 'a', framework: 'vue' },
        ]),
    ).toThrow(/Duplicate/);
    expect(
      () => new IslandRegistry([{ id: 'a', framework: 'angular' as 'react' }]),
    ).toThrow(/framework/);
    expect(() => registry.render('not-registered')).toThrow(/Unknown island/);
    expect(registry.ids()).toEqual(['revenue-chart', 'feed', 'tiny']);
  });

  it('renders escaped JSON props, strategy, key and accessible label', () => {
    const html = registry.render(
      'revenue-chart',
      { title: '</div><script>alert(1)</script>', quote: `"'&` },
      { key: 'chart', label: 'Revenue "chart"', fallback: '<b>Loading</b>' },
    ).value;
    expect(html).toContain('data-nv-island="revenue-chart"');
    expect(html).toContain('data-nv-framework="react"');
    expect(html).toContain('data-nv-mount="immediate"');
    expect(html).toContain('data-nv-key="island:chart"');
    expect(html).toContain(
      'role="region" aria-label="Revenue &quot;chart&quot;"',
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;/div&gt;&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;Loading&lt;/b&gt;</div>');
    const trusted = registry.render(
      'feed',
      {},
      { fallback: SafeHtml.trusted('<p>SSR</p>') },
    ).value;
    expect(trusted).toContain('<p>SSR</p></div>');
    expect(trusted).toContain('data-nv-mount="visible"');
    const attribute = /data-nv-props="([^"]*)"/.exec(html)?.[1] ?? '';
    const decoded = attribute
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
    expect(JSON.parse(decoded)).toEqual({
      title: '</div><script>alert(1)</script>',
      quote: `"'&`,
    });
  });

  it('accepts only bounded plain JSON props', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    for (const bad of [
      { fn: () => 1 },
      { date: new Date() },
      { big: 1n },
      { nan: Number.NaN },
      cyclic,
      JSON.parse('{"__proto__":{"x":1}}'),
    ])
      expect(() => serializeProps(bad, 10_000)).toThrow(IslandError);
    expect(() => registry.render('tiny', { text: 'x'.repeat(64) })).toThrow(
      /exceed/,
    );
    expect(() => registry.render('feed', {}, { key: 'bad key!' })).toThrow(
      /key/,
    );
    expect(() =>
      registry.render('feed', {}, { strategy: 'eager' as 'idle' }),
    ).toThrow(/strategy/);
  });

  it('provides an engine-neutral template helper', () => {
    const { nvIsland } = registry.helpers();
    const hbsOptions = {
      hash: { key: 'f', label: 'Feed', items: ['a'] },
      data: {},
    };
    const fromHbs = nvIsland('feed', hbsOptions).value;
    expect(fromHbs).toContain('data-nv-key="island:f"');
    expect(fromHbs).toContain('aria-label="Feed"');
    expect(fromHbs).toContain('{&quot;items&quot;:[&quot;a&quot;]}');
    expect(nvIsland('feed', { items: [] }).value).toContain(
      'data-nv-island="feed"',
    );
    expect(() => nvIsland()).toThrow(/island id/);
  });
});

describe('island props schema, secrets and signing', () => {
  const key = 'island-signing-key-0123456789abcdef';
  let now = 1_700_000_000_000;
  const signed = new IslandRegistry(
    [
      {
        id: 'order-summary',
        framework: 'react',
        signed: true,
        props: {
          type: 'object',
          properties: {
            orderId: { type: 'integer', minimum: 1 },
            status: { type: 'string', enum: ['open', 'paid'] },
            lines: {
              type: 'array',
              maxItems: 2,
              items: { type: 'string', maxLength: 8 },
            },
          },
          required: ['orderId'],
        },
      },
      { id: 'debug', framework: 'vue', allowSensitiveKeys: true },
    ],
    { signingKeys: [key], signatureTtlMs: 60_000, now: () => now },
  );
  const token = (html: string) =>
    /data-nv-props-token="([^"]+)"/.exec(html)?.[1] ?? '';

  it('enforces closed props schemas so undeclared (secret) fields never reach markup', () => {
    expect(
      signed.render('order-summary', { orderId: 4, status: 'paid' }).value,
    ).toContain('data-nv-props="{&quot;orderId&quot;:4');
    for (const bad of [
      { orderId: 0 },
      { orderId: 1.5 },
      { status: 'open' },
      { orderId: 1, status: 'refunded' },
      { orderId: 1, lines: ['a', 'b', 'c'] },
      { orderId: 1, lines: ['way too long'] },
      { orderId: 1, customer: { email: 'a@example.com' } },
    ])
      expect(() => signed.render('order-summary', bad)).toThrow(
        /Invalid props/,
      );
    expect(
      () =>
        new IslandRegistry([
          { id: 'x', framework: 'react', props: { type: 'object' } as never },
        ]),
    ).toThrow(/props schema/);
  });

  it('rejects secret-like prop keys unless explicitly allowed', () => {
    for (const props of [
      { password: 'hunter2' },
      { user: { apiKey: 'k' } },
      { sessionId: 's' },
      { csrfToken: 't' },
      { nested: [{ accessToken: 'a' }] },
    ])
      expect(() => registry.render('feed', props)).toThrow(/secret-like/);
    expect(
      registry.render('feed', { compass: 'n', passage: 'p' }).value,
    ).toContain('compass');
    expect(
      signed.render('debug', { token: 'visible-by-choice' }).value,
    ).toContain('visible-by-choice');
  });

  it('signs props and rejects tampered, foreign, expired and unsigned tokens', () => {
    const html = signed.render('order-summary', { orderId: 7 }).value;
    const json = '{"orderId":7}';
    const value = token(html);
    expect(value).toMatch(/^v1\.\d+\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(signed.verifyProps('order-summary', json, value)).toEqual({
      orderId: 7,
    });
    expect(() =>
      signed.verifyProps('order-summary', '{"orderId":8}', value),
    ).toThrow(/signature mismatch/);
    const flipped = value.slice(0, -2) + (value.endsWith('AA') ? 'BB' : 'AA');
    expect(() => signed.verifyProps('order-summary', json, flipped)).toThrow(
      IslandError,
    );
    const [, iat = '', exp = '', mac = ''] = value.split('.');
    expect(() =>
      signed.verifyProps(
        'order-summary',
        json,
        `v1.${iat}.${Number(exp) + 3600}.${mac}`,
      ),
    ).toThrow(/signature mismatch/);
    expect(() => signed.verifyProps('debug', json, value)).toThrow(IslandError);
    expect(() => signed.verifyProps('order-summary', json, 'garbage')).toThrow(
      /Invalid island props token/,
    );
    now += 61_000;
    expect(() => signed.verifyProps('order-summary', json, value)).toThrow(
      /expired/,
    );
    // Rotation: a token signed with the old key verifies under [new, old].
    const rotated = new IslandRegistry(
      [{ id: 'order-summary', framework: 'react', signed: true }],
      {
        signingKeys: ['new-island-signing-key-0123456789abcdef', key],
        now: () => now,
      },
    );
    const fresh = token(signed.render('order-summary', { orderId: 9 }).value);
    expect(
      rotated.verifyProps('order-summary', '{"orderId":9}', fresh),
    ).toEqual({ orderId: 9 });
    expect(
      () => new IslandRegistry([{ id: 'a', framework: 'react', signed: true }]),
    ).toThrow(/signingKeys/);
    expect(
      () =>
        new IslandRegistry([{ id: 'a', framework: 'react' }], {
          signingKeys: ['short'],
        }),
    ).toThrow(/32 bytes/);
  });
});

describe('island context, noscript, SSR and manifests', () => {
  it('renders a validated, script-safe shared context', () => {
    const html = registry.contextScript({
      locale: 'ar-EG',
      direction: 'rtl',
      theme: { 'brand-primary': '#2f5bff', 'radius-md': '8px' },
      user: { name: '</script><script>alert(1)</script>', admin: false },
    }).value;
    expect(
      html.startsWith(
        '<script type="application/json" id="nv-islands-context">',
      ),
    ).toBe(true);
    expect(html.match(/<\/script>/g)?.length).toBe(1);
    expect(html).toContain('\\u003c/script\\u003e');
    for (const bad of [
      { theme: { 'brand-primary': 'red; background:url(x)' } },
      { theme: { Bad: '1px' } },
      { user: { sessionId: 'x' } },
      { user: { profile: { nested: true } } },
      { locale: 'en_US<' },
      { direction: 'up' },
      { tenantId: 'acme' },
    ])
      expect(() => registry.contextScript(bad as never)).toThrow();
  });

  it('adds sibling noscript content and keeps it escaped unless trusted', () => {
    const html = registry.render(
      'feed',
      {},
      { fallback: 'Loading…', noscript: 'Enable <JavaScript>' },
    ).value;
    expect(html).toMatch(
      /<\/div><noscript data-nv-island-noscript="feed">Enable &lt;JavaScript&gt;<\/noscript>$/,
    );
    expect(
      registry.render(
        'feed',
        {},
        { noscript: SafeHtml.trusted('<a href="/feed">Open feed</a>') },
      ).value,
    ).toContain('<a href="/feed">Open feed</a></noscript>');
    const { nvIsland } = registry.helpers();
    expect(
      nvIsland('feed', { hash: { noscript: 'No JS' }, data: {} }).value,
    ).toContain('<noscript data-nv-island-noscript="feed">No JS</noscript>');
  });

  it('server-renders with registered renderers and falls back on failure', async () => {
    const errors: string[] = [];
    const ssr = new IslandRegistry(
      [
        { id: 'greeting', framework: 'custom' },
        { id: 'broken', framework: 'custom' },
      ],
      {
        renderers: {
          greeting: (props, context) =>
            `<p>Hello ${String(props['name'])} (${context.shared.locale ?? '?'})</p>`,
          broken: () => {
            throw new Error('render failed');
          },
        },
        onRenderError: (error, id) =>
          errors.push(`${id}:${error instanceof Error ? error.message : ''}`),
      },
    );
    const html = (
      await ssr.renderSsr(
        'greeting',
        { name: 'Ada' },
        { context: { locale: 'en' } },
      )
    ).value;
    expect(html).toContain('data-nv-ssr=""');
    expect(html).toContain('<p>Hello Ada (en)</p></div>');
    const fallback = (
      await ssr.renderSsr('broken', {}, { fallback: 'Unavailable' })
    ).value;
    expect(fallback).not.toContain('data-nv-ssr');
    expect(fallback).toContain('>Unavailable</div>');
    expect(errors).toEqual(['broken:render failed']);
    await expect(registry.renderSsr('feed')).rejects.toThrow(
      /No server renderer/,
    );
    expect(
      () =>
        new IslandRegistry([{ id: 'a', framework: 'custom' }], {
          renderers: { b: () => '' },
        }),
    ).toThrow(/unknown island/);
  });

  it('builds and parses manifests with safe bundle paths', () => {
    const manifest = createIslandManifest(
      [
        {
          id: 'revenue-chart',
          framework: 'react',
          strategy: 'immediate',
          entry: 'client/react-chart.tsx',
          budgetBytes: 90_000,
        },
      ],
      {
        outputs: {
          'dist/public/islands/react-chart-ABCD1234.js': {
            bytes: 10,
            entryPoint: 'client/react-chart.tsx',
            imports: [],
            inputs: {},
          },
        },
      },
      { outdir: 'dist/public/islands', publicPath: '/islands/', root: '/app' },
    );
    expect(manifest).toEqual({
      version: 1,
      islands: {
        'revenue-chart': {
          framework: 'react',
          strategy: 'immediate',
          bundle: '/islands/react-chart-ABCD1234.js',
          maxPropsBytes: 32_768,
          budgetBytes: 90_000,
        },
      },
    });
    const fromManifest = IslandRegistry.fromManifest(manifest);
    expect(fromManifest.ids()).toEqual(['revenue-chart']);
    // Markup never names code: the bundle path stays out of the island root.
    expect(fromManifest.render('revenue-chart').value).not.toContain(
      '/islands/',
    );
    expect(fromManifest.preload(['revenue-chart']).value).toBe(
      '<link rel="modulepreload" href="/islands/react-chart-ABCD1234.js">',
    );
    expect(fromManifest.manifest()).toEqual(manifest);
    for (const bundle of [
      '//evil.example/x.js',
      'https://evil.example/x.js',
      '/islands/../secret.js',
      '/islands/x.css',
      'javascript:alert(1)',
    ])
      expect(() =>
        parseIslandManifest({
          version: 1,
          islands: {
            a: {
              framework: 'react',
              strategy: 'idle',
              bundle,
              maxPropsBytes: 10,
            },
          },
        }),
      ).toThrow(/Invalid island manifest entry/);
    expect(() => parseIslandManifest({ version: 2, islands: {} })).toThrow();
    expect(() =>
      createIslandManifest(
        [{ id: 'missing', framework: 'vue', entry: 'client/none.ts' }],
        { outputs: {} },
        { outdir: 'dist', publicPath: '/' },
      ),
    ).toThrow(/No bundle output/);
  });

  it('validates values in the shared schema checker', () => {
    expect(
      checkIslandProps(
        { anyOf: [{ type: 'null' }, { type: 'string', maxLength: 2 }] },
        'abc',
      ),
    ).toMatch(/no allowed shape/);
    expect(checkIslandProps({ type: 'boolean' }, true)).toBeUndefined();
  });
});
