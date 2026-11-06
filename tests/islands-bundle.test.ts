import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { analyzeIslandBundles } from '../packages/islands/dist/build.js';
import { IslandRegistry } from '../packages/islands/dist/index.js';
import type { IslandServerRenderer } from '../packages/islands/dist/index.js';

// Bundle-analyzer evidence from the hybrid dashboard build (pnpm build runs it).
const root = 'examples/hybrid-dashboard';
const json = async (file: string): Promise<unknown> =>
  JSON.parse(await readFile(`${root}/${file}`, 'utf8'));

describe('hybrid dashboard island bundles', () => {
  it('keeps each framework runtime in its own islands and within budget', async () => {
    const manifest = (await json(
      'dist/public/islands-manifest.json',
    )) as Parameters<typeof analyzeIslandBundles>[0];
    const metafile = (await json(
      'dist/public/islands-metafile.json',
    )) as Parameters<typeof analyzeIslandBundles>[1];
    const report = analyzeIslandBundles(manifest, metafile, {
      outdir: 'dist/public/islands',
      publicPath: '/islands/',
      root,
    });
    expect(report.violations).toEqual([]);
    const byId = new Map(report.islands.map((island) => [island.id, island]));
    for (const [id, framework] of [
      ['revenue-chart', 'react'],
      ['react-kpi', 'react'],
      ['activity-feed', 'vue'],
      ['status-widget', 'svelte'],
    ] as const) {
      const island = byId.get(id);
      expect(island?.framework).toBe(framework);
      const runtimes = new Set(
        island?.chunks.flatMap((chunk) => chunk.frameworks),
      );
      expect([...runtimes]).toEqual([framework]);
      expect(island?.withinBudget).toBe(true);
    }
    // Two React islands share one React runtime chunk instead of duplicating it.
    expect(report.frameworks['react']).toHaveLength(1);
    expect(report.frameworks['vue']?.length).toBeGreaterThanOrEqual(1);
    expect(report.frameworks['svelte']?.length).toBeGreaterThanOrEqual(1);
    const vueFiles = new Set(report.frameworks['vue']);
    for (const file of report.frameworks['react'] ?? [])
      expect(vueFiles.has(file)).toBe(false);
    // The custom island loads no framework at all.
    expect(
      byId.get('broken-island')?.chunks.flatMap((c) => c.frameworks),
    ).toEqual([]);
  });

  it('server-renders Vue, Svelte and React islands from the SSR bundle', async () => {
    const manifest = await json('dist/public/islands-manifest.json');
    const ssr = (await import(
      new URL(`../${root}/dist/ssr/islands-ssr.js`, import.meta.url).href
    )) as { renderers: Record<string, IslandServerRenderer> };
    const registry = IslandRegistry.fromManifest(manifest, {
      signingKeys: ['ssr-test-signing-key-0123456789abcdef'],
      renderers: ssr.renderers,
    });
    const feed = (
      await registry.renderSsr('activity-feed', { items: ['<b>a</b>'] })
    ).value;
    expect(feed).toContain('data-nv-ssr=""');
    expect(feed).toContain('<li>&lt;b&gt;a&lt;/b&gt;</li>');
    const widget = (
      await registry.renderSsr('status-widget', {
        label: 'Sync',
        workspace: 'demo',
      })
    ).value;
    expect(widget).toContain('Sync: online');
    expect(widget).toMatch(/data-nv-props-token="v1\./);
    const kpi = (
      await registry.renderSsr(
        'react-kpi',
        { label: 'Users', value: 3 },
        { context: { locale: 'ar' } },
      )
    ).value;
    expect(kpi.replaceAll('<!-- -->', '')).toContain('Users: 3');
    expect(kpi.replaceAll('<!-- -->', '')).toContain('Locale ar');
    // Server props schemas apply to SSR as well.
    await expect(
      registry.renderSsr('react-kpi', { label: 'x', value: 1, extra: 1 }),
    ).rejects.toThrow(/Invalid props/);
  });
});
