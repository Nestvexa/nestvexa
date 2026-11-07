/**
 * Chart wrapper of the @nestvexa/ui markup contract: server-rendered SVG bar,
 * line and sparkline charts, or a container for a third-party chart, always
 * followed by a data table listing every value.
 *
 * CSP-safe by construction: no script, no `style` attribute and no event
 * handler attributes. The SVG carries geometry only; colors, strokes and text
 * placement come from classes (`nv-chart__series--1` … `--8`) styled by the
 * theme through custom properties. Data is validated: finite numbers within
 * ±1e15, at most 200 labels and 8 series.
 */
import {
  UiError,
  classes,
  flag,
  id,
  list,
  localeTag,
  oneOf,
  optionalText,
  record,
  text,
} from './html.js';
import { element, slot } from './tree.js';
import type { MarkupElement, MarkupInput, MarkupNode } from './tree.js';

export const chartTypes = ['bar', 'line', 'sparkline', 'custom'] as const;
export type ChartType = (typeof chartTypes)[number];

const maxLabels = 200;
const maxSeries = 8;
const magnitude = 1e15;

function finite(value: unknown, name: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > magnitude
  )
    throw new UiError(
      'ARGUMENT',
      `${name} must be finite numbers within ±${magnitude}`,
    );
  // Normalize -0 so it prints as 0.
  return value + 0;
}
function optionalFinite(value: unknown, name: string): number | undefined {
  return value === undefined || value === null
    ? undefined
    : finite(value, name);
}

interface Series {
  readonly name: string;
  readonly values: readonly number[];
}
function seriesList(value: unknown, points: number, type: ChartType): Series[] {
  const raw = list(value, 'series', type === 'sparkline' ? 1 : maxSeries);
  return raw.map((entry) => {
    const series = record(entry, 'series', ['name', 'values']);
    const values = series['values'];
    if (!Array.isArray(values) || values.length !== points)
      throw new UiError('ARGUMENT', 'Each series needs one value per label');
    return {
      name: text(series['name'], 'series name', 128),
      values: values.map((item: unknown) => finite(item, 'values')),
    };
  });
}

/** Geometry rounded to 0.01 so every renderer prints the same strings. */
const coordinate = (value: number): string =>
  String(Math.round(value * 100) / 100 + 0);

interface Frame {
  readonly width: number;
  readonly height: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}
const frames: Readonly<Record<'chart' | 'sparkline', Frame>> = {
  chart: { width: 640, height: 320, top: 16, right: 16, bottom: 40, left: 72 },
  sparkline: { width: 120, height: 32, top: 3, right: 3, bottom: 3, left: 3 },
};
/** Category labels are drawn up to this count; the table always has them all. */
const maxAxisLabels = 12;
/** Point markers are drawn on line charts up to this count. */
const maxMarkers = 60;

const shortLabel = (label: string): string =>
  [...label].length > 16 ? `${[...label].slice(0, 15).join('')}…` : label;

interface Plot {
  readonly frame: Frame;
  readonly lo: number;
  readonly hi: number;
  readonly y: (value: number) => number;
}
function plot(
  type: ChartType,
  values: readonly number[],
  min: number | undefined,
  max: number | undefined,
): Plot {
  const frame = type === 'sparkline' ? frames.sparkline : frames.chart;
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  if (min !== undefined && min > dataMin)
    throw new UiError('ARGUMENT', 'min must not exceed the smallest value');
  if (max !== undefined && max < dataMax)
    throw new UiError('ARGUMENT', 'max must not be below the largest value');
  if (min !== undefined && max !== undefined && min >= max)
    throw new UiError('ARGUMENT', 'min must be below max');
  // Bars grow from zero, so the domain includes it unless min/max say otherwise.
  let lo = min ?? (type === 'bar' ? Math.min(dataMin, 0) : dataMin);
  let hi = max ?? (type === 'bar' ? Math.max(dataMax, 0) : dataMax);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const height = frame.height - frame.top - frame.bottom;
  return {
    frame,
    lo,
    hi,
    y: (value) => frame.top + ((hi - value) / (hi - lo)) * height,
  };
}

function axes(
  chart: Plot,
  labels: readonly string[],
  center: (index: number) => number,
  format: (value: number) => string,
): MarkupElement {
  const { frame, lo, hi } = chart;
  const ticks = [hi, lo];
  if (lo < 0 && hi > 0) ticks.splice(1, 0, 0);
  const right = frame.width - frame.right;
  const nodes: MarkupNode[] = ticks.flatMap((tick) => {
    const y = coordinate(chart.y(tick));
    return [
      element('line', {
        class: tick === 0 ? 'nv-chart__axis' : 'nv-chart__grid',
        x1: frame.left,
        y1: y,
        x2: right,
        y2: y,
      }),
      element(
        'text',
        {
          class: 'nv-chart__tick nv-chart__tick--y',
          x: frame.left - 8,
          y,
        },
        [format(tick)],
      ),
    ];
  });
  if (labels.length <= maxAxisLabels)
    labels.forEach((label, index) =>
      nodes.push(
        element(
          'text',
          {
            class: 'nv-chart__tick nv-chart__tick--x',
            x: coordinate(center(index)),
            y: frame.height - frame.bottom + 20,
          },
          [shortLabel(label)],
        ),
      ),
    );
  return element('g', { class: 'nv-chart__axes' }, nodes);
}

function bars(
  chart: Plot,
  series: readonly Series[],
  points: number,
): MarkupNode[] {
  const { frame, lo, hi } = chart;
  const band = (frame.width - frame.left - frame.right) / points;
  const width = (band * 0.8) / series.length;
  const base = chart.y(Math.min(Math.max(0, lo), hi));
  return series.map((entry, position) =>
    element(
      'g',
      { class: `nv-chart__series nv-chart__series--${position + 1}` },
      entry.values.map((value, index) => {
        const top = chart.y(value);
        return element('rect', {
          class: 'nv-chart__bar',
          x: coordinate(
            frame.left + index * band + band * 0.1 + position * width,
          ),
          y: coordinate(Math.min(top, base)),
          width: coordinate(width),
          height: coordinate(Math.abs(base - top)),
        });
      }),
    ),
  );
}

/**
 * Horizontal position of each category: band centers (like bars, so the
 * axis labels stay inside the image), or edge to edge for sparklines.
 */
function positions(
  frame: Frame,
  points: number,
  edges: boolean,
): (index: number) => number {
  const width = frame.width - frame.left - frame.right;
  if (edges && points > 1)
    return (index) => frame.left + (index * width) / (points - 1);
  return (index) => frame.left + (width / points) * (index + 0.5);
}
function lines(
  chart: Plot,
  series: readonly Series[],
  x: (index: number) => number,
  markers: boolean,
): MarkupNode[] {
  return series.map((entry, position) => {
    const points = entry.values.map(
      (value, index) =>
        [coordinate(x(index)), coordinate(chart.y(value))] as const,
    );
    return element(
      'g',
      { class: `nv-chart__series nv-chart__series--${position + 1}` },
      [
        element('polyline', {
          class: 'nv-chart__line',
          points: points.map(([px, py]) => `${px},${py}`).join(' '),
        }),
        ...(markers
          ? points.map(([cx, cy]) =>
              element('circle', { class: 'nv-chart__point', cx, cy, r: 3 }),
            )
          : []),
      ],
    );
  });
}

/**
 * Accessible chart in a `<figure>`: a `<figcaption>` title (`{id}-title`),
 * an optional description (`{id}-desc`), the chart image and a data table
 * (`{id}-data`, in a wrapper that is visually hidden unless `showTable`).
 *
 * `type` `bar` (default), `line` or `sparkline` renders `<svg role="img">`
 * named by the title and described by the description. `custom` renders a
 * `role="img"` container (`{id}-canvas`) around the `chart` slot for a
 * third-party chart (canvas or SVG); the table remains its accessible form.
 * Input: `labels` (1–200 strings), `series` (`[{ name, values }]`, 1–8, one
 * finite value per label; sparklines take one series), `categoryLabel` (the
 * table's first column header), optional `min`/`max` domain and `locale` for
 * number formatting.
 */
export function chartMarkup(input: MarkupInput): MarkupElement {
  const chartId = id(input['id'], 'id');
  const type = oneOf(input['type'], 'type', chartTypes, 'bar');
  const title = text(input['title'], 'title');
  const description = optionalText(input['description'], 'description', 2048);
  const categoryLabel = text(input['categoryLabel'], 'categoryLabel', 128);
  const labels = list(input['labels'], 'labels', maxLabels).map((label) =>
    text(label, 'label', 128),
  );
  const series = seriesList(input['series'], labels.length, type);
  const min = optionalFinite(input['min'], 'min');
  const max = optionalFinite(input['max'], 'max');
  const tag = localeTag(input['locale']);
  const showTable = flag(input['showTable'], 'showTable');
  const className = classes(input['class']);
  const numbers = tag ? new Intl.NumberFormat(tag) : undefined;
  const format = (value: number): string =>
    numbers ? numbers.format(value) : String(value);
  const titleId = `${chartId}-title`;
  const descriptionId = description ? `${chartId}-desc` : undefined;
  const image = {
    role: 'img',
    'aria-labelledby': titleId,
    'aria-describedby': descriptionId,
  };

  let graphic: MarkupElement;
  if (type === 'custom') {
    graphic = element(
      'div',
      { class: 'nv-chart__canvas', id: `${chartId}-canvas`, ...image },
      [slot('chart')],
    );
  } else {
    const chart = plot(
      type,
      series.flatMap((entry) => entry.values),
      min,
      max,
    );
    const { frame } = chart;
    const x = positions(frame, labels.length, type === 'sparkline');
    const marks =
      type === 'bar'
        ? bars(chart, series, labels.length)
        : lines(
            chart,
            series,
            x,
            type === 'line' && labels.length <= maxMarkers,
          );
    graphic = element(
      'svg',
      {
        class: 'nv-chart__svg',
        viewBox: `0 0 ${frame.width} ${frame.height}`,
        ...image,
      },
      type === 'sparkline' ? marks : [axes(chart, labels, x, format), ...marks],
    );
  }

  const legend =
    series.length > 1
      ? [
          element(
            'ul',
            { class: 'nv-chart__legend', 'aria-hidden': 'true' },
            series.map((entry, position) =>
              element('li', { class: 'nv-chart__key' }, [
                element('span', {
                  class: `nv-chart__swatch nv-chart__series--${position + 1}`,
                }),
                entry.name,
              ]),
            ),
          ),
        ]
      : [];
  const table = element(
    'table',
    {
      class: 'nv-chart__table',
      id: `${chartId}-data`,
    },
    [
      element('caption', { class: 'nv-chart__caption' }, [title]),
      element('thead', {}, [
        element('tr', {}, [
          element('th', { scope: 'col' }, [categoryLabel]),
          ...series.map((entry) =>
            element('th', { scope: 'col' }, [entry.name]),
          ),
        ]),
      ]),
      element(
        'tbody',
        {},
        labels.map((label, index) =>
          element('tr', {}, [
            element('th', { scope: 'row' }, [label]),
            ...series.map((entry) => {
              const value = entry.values[index] ?? 0;
              return element('td', { 'data-value': String(value) }, [
                format(value),
              ]);
            }),
          ]),
        ),
      ),
    ],
  );
  const base = `nv-chart nv-chart--${type}`;
  return element(
    'figure',
    {
      class: className ? `${base} ${className}` : base,
      id: chartId,
      'data-nv-ui-chart': type,
    },
    [
      element('figcaption', { class: 'nv-chart__title', id: titleId }, [title]),
      ...(description
        ? [
            element(
              'p',
              { class: 'nv-chart__description', id: descriptionId },
              [description],
            ),
          ]
        : []),
      graphic,
      ...legend,
      // Tables do not shrink into the 1px visually hidden box; a wrapper does.
      element(
        'div',
        {
          class: showTable
            ? 'nv-chart__data'
            : 'nv-chart__data nv-visually-hidden',
        },
        [table],
      ),
    ],
  );
}
