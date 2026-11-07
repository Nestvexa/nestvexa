import { defineComponent, h } from 'vue';
import type { PropType } from 'vue';

/**
 * Dependency-free SVG bar chart shared by the dashboard island and the
 * Inertia analytics page. The SVG is decorative for assistive technology
 * (`aria-hidden`); the same numbers are always rendered as a data table, so
 * screen readers and keyboard users get the values, not a picture.
 * No inline styles: the page CSP has no `'unsafe-inline'` for styles.
 */
export const BarChart = defineComponent({
  name: 'BarChart',
  props: {
    idPrefix: { type: String, required: true },
    caption: { type: String, required: true },
    labels: { type: Array as PropType<readonly string[]>, required: true },
    values: { type: Array as PropType<readonly number[]>, required: true },
  },
  setup(props) {
    const width = 320;
    const height = 140;
    return () => {
      const max = Math.max(1, ...props.values);
      const slot = width / Math.max(1, props.values.length);
      const bars = props.values.map((value, index) => {
        const barHeight = Math.round((value / max) * (height - 24));
        return h('g', { key: `${props.labels[index] ?? index}` }, [
          h('rect', {
            class: 'chart-bar',
            x: Math.round(index * slot + slot * 0.15),
            y: height - 16 - barHeight,
            width: Math.round(slot * 0.7),
            height: barHeight,
          }),
          h(
            'text',
            {
              class: 'chart-label',
              x: Math.round(index * slot + slot / 2),
              y: height - 2,
              'text-anchor': 'middle',
            },
            props.labels[index] ?? '',
          ),
        ]);
      });
      return h('figure', { class: 'chart', id: `${props.idPrefix}-figure` }, [
        h('figcaption', { id: `${props.idPrefix}-caption` }, props.caption),
        h(
          'svg',
          {
            viewBox: `0 0 ${width} ${height}`,
            class: 'chart-svg',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          bars,
        ),
        h(
          'table',
          {
            class: 'chart-table',
            id: `${props.idPrefix}-table`,
            'aria-labelledby': `${props.idPrefix}-caption`,
          },
          [
            h('thead', [
              h('tr', [
                h('th', { scope: 'col' }, 'Week'),
                h('th', { scope: 'col' }, 'Tasks'),
              ]),
            ]),
            h(
              'tbody',
              props.values.map((value, index) =>
                h('tr', { key: `${props.labels[index] ?? index}` }, [
                  h('th', { scope: 'row' }, props.labels[index] ?? ''),
                  h('td', String(value)),
                ]),
              ),
            ),
          ],
        ),
      ]);
    };
  },
});
