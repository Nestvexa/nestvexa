import { Logger } from '@nestjs/common';
import { IslandRegistry, moduleIslandRenderers } from '@nestvexa/islands';
import type { I18nContext } from '@nestvexa/i18n';
import type { SafeHtml } from 'nestvexa';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exampleRoot } from './config.js';
import { i18n } from './i18n.js';

const logger = new Logger('Islands');

const text = (maxLength: number) => ({ type: 'string', maxLength }) as const;
const count = { type: 'integer', minimum: 0, maximum: 100_000 } as const;

/**
 * Server-side island allowlist with closed props schemas; the browser loader
 * holds the matching module map (client/islands/loader.ts). SSR comes from
 * the shared Vite SSR bundle. Every visible string arrives translated in the
 * props, so the server-rendered markup and the hydrated island agree.
 */
export const islands = new IslandRegistry(
  [
    {
      id: 'throughput-chart',
      framework: 'vue',
      strategy: 'visible',
      props: {
        type: 'object',
        properties: {
          captionAll: text(120),
          captionRecent: text(120),
          rangeLabel: text(40),
          allLabel: text(40),
          recentLabel: text(40),
          labels: { type: 'array', maxItems: 52, items: text(8) },
          values: { type: 'array', maxItems: 52, items: count },
        },
        required: [
          'captionAll',
          'captionRecent',
          'rangeLabel',
          'allLabel',
          'recentLabel',
          'labels',
          'values',
        ],
      },
    },
    {
      // React chart on the @nestvexa/ui chart wrapper. The server-rendered SVG
      // and data table are complete without JavaScript; React itself loads on
      // the first hover, focus, pointer or key press on the chart.
      id: 'member-chart',
      framework: 'react',
      strategy: 'interaction',
      props: {
        type: 'object',
        properties: {
          locale: text(35),
          title: text(80),
          category: text(40),
          openLabel: text(40),
          doneLabel: text(40),
          typeLabel: text(40),
          barsLabel: text(40),
          linesLabel: text(40),
          members: {
            type: 'array',
            maxItems: 20,
            items: {
              type: 'object',
              properties: {
                name: text(60),
                focusLabel: text(120),
                open: count,
                done: count,
              },
              required: ['name', 'focusLabel', 'open', 'done'],
            },
          },
        },
        required: [
          'locale',
          'title',
          'category',
          'openLabel',
          'doneLabel',
          'typeLabel',
          'barsLabel',
          'linesLabel',
          'members',
        ],
      },
    },
    {
      // Svelte widget; hydrates when the browser is idle.
      id: 'pulse-widget',
      framework: 'svelte',
      strategy: 'idle',
      props: {
        type: 'object',
        properties: {
          progressText: text(120),
          percentText: text(120),
          showPercentLabel: text(40),
          showCountsLabel: text(40),
          pickText: text(160),
          done: count,
          total: count,
        },
        required: [
          'progressText',
          'percentText',
          'showPercentLabel',
          'showCountsLabel',
          'pickText',
          'done',
          'total',
        ],
      },
    },
  ],
  {
    renderers: moduleIslandRenderers(
      ['throughput-chart', 'member-chart', 'pulse-widget'],
      () => import(pathToFileURL(join(exampleRoot, 'dist/ssr/ssr.js')).href),
    ),
    // A failing renderer degrades to the fallback; the client still mounts it.
    onRenderError: (error, id) =>
      logger.warn(
        `Island ${id} SSR failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      ),
  },
);

export interface DashboardData {
  /** Weekly completed-task counts, oldest first. */
  readonly throughput: readonly number[];
  readonly members: readonly {
    readonly name: string;
    readonly open: number;
    readonly done: number;
  }[];
}

/**
 * The dashboard's three islands in the request's locale, plus the `<head>`
 * data they read in the browser: the islands page context (locale and
 * direction) and the one message the Svelte widget formats itself
 * (`islands:pulse.focus`). Both are JSON scripts, inert under the CSP.
 */
export async function dashboardIslands(
  t: I18nContext,
  data: DashboardData,
): Promise<{ head: string; islands: Record<string, SafeHtml> }> {
  const context = { locale: t.locale, direction: t.dir } as const;
  const values = [...data.throughput];
  const title = t.t('islands:throughput.title');
  const done = data.members.reduce((sum, member) => sum + member.done, 0);
  const total = data.members.reduce(
    (sum, member) => sum + member.open + member.done,
    0,
  );
  const head =
    islands.contextScript(context).value +
    i18n.hydrationScript(
      i18n.hydration(t.locale, { keys: ['islands:pulse.focus'] }),
    ).value;
  return {
    head,
    islands: {
      chart: await islands.renderSsr(
        'throughput-chart',
        {
          captionAll: t.t('islands:throughput.caption', {
            title,
            count: values.length,
          }),
          captionRecent: t.t('islands:throughput.caption', {
            title,
            count: Math.min(4, values.length),
          }),
          rangeLabel: t.t('islands:throughput.range'),
          allLabel: t.t('islands:throughput.all'),
          recentLabel: t.t('islands:throughput.recent'),
          labels: values.map((_, index) => `W${index + 1}`),
          values,
        },
        {
          label: t.t('islands:throughput.label'),
          fallback: t.t('islands:throughput.loading'),
          context,
        },
      ),
      members: await islands.renderSsr(
        'member-chart',
        {
          locale: t.locale,
          title: t.t('islands:members.title'),
          category: t.t('islands:members.category'),
          openLabel: t.t('islands:members.open'),
          doneLabel: t.t('islands:members.done'),
          typeLabel: t.t('islands:members.type'),
          barsLabel: t.t('islands:members.bars'),
          linesLabel: t.t('islands:members.lines'),
          members: data.members.map((member) => ({
            ...member,
            focusLabel: t.t('islands:members.focus', { name: member.name }),
          })),
        },
        {
          label: t.t('islands:members.label'),
          fallback: t.t('islands:members.loading'),
          context,
        },
      ),
      pulse: await islands.renderSsr(
        'pulse-widget',
        {
          progressText: t.t('islands:pulse.progress', { done, total }),
          percentText: t.t('islands:pulse.percent', {
            percent: total ? done / total : 0,
          }),
          showPercentLabel: t.t('islands:pulse.showPercent'),
          showCountsLabel: t.t('islands:pulse.showCounts'),
          pickText: t.t('islands:pulse.pick'),
          done,
          total,
        },
        { label: t.t('islands:pulse.label'), context },
      ),
    },
  };
}
