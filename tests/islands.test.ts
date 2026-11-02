import { describe, expect, it } from 'vitest';
import {
  IslandError,
  IslandRegistry,
  serializeProps,
} from '../packages/islands/dist/index.js';
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
