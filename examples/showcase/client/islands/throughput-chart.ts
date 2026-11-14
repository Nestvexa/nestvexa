import { defineComponent, h, onMounted, ref } from 'vue';
import type { PropType } from 'vue';
import type { IslandContext } from '@nestvexa/islands/client';
import { vueIsland } from '@nestvexa/islands/vue';
import { BarChart } from '../shared/bar-chart.js';

/**
 * Dashboard island (Vue): server-rendered (SSR) and hydrated. The range toggle is
 * local framework state; Live re-renders of the metrics panel next to it never
 * touch it (islands are separate ownership boundaries). Captions and labels
 * arrive translated in the props.
 */
export const ThroughputChart = defineComponent({
  props: {
    captionAll: { type: String, required: true },
    captionRecent: { type: String, required: true },
    rangeLabel: { type: String, required: true },
    allLabel: { type: String, required: true },
    recentLabel: { type: String, required: true },
    labels: { type: Array as PropType<string[]>, required: true },
    values: { type: Array as PropType<number[]>, required: true },
    // Declared so the loader's context is not rendered as a fallthrough attribute.
    island: { type: Object as PropType<IslandContext>, required: true },
  },
  setup(props) {
    const recent = ref(false);
    const hydrated = ref(false);
    onMounted(() => {
      hydrated.value = true;
    });
    const toggle = (value: boolean) =>
      h(
        'button',
        {
          type: 'button',
          id: value ? 'chart-range-recent' : 'chart-range-all',
          'aria-pressed': recent.value === value ? 'true' : 'false',
          onClick: () => {
            recent.value = value;
          },
        },
        value ? props.recentLabel : props.allLabel,
      );
    return () => {
      const count = recent.value
        ? Math.min(4, props.values.length)
        : props.values.length;
      return h(
        'div',
        {
          class: 'island-chart',
          'data-hydrated': hydrated.value ? 'true' : 'false',
        },
        [
          h('p', { role: 'group', 'aria-label': props.rangeLabel }, [
            toggle(false),
            ' ',
            toggle(true),
          ]),
          h(BarChart, {
            idPrefix: 'dashboard-chart',
            caption: recent.value ? props.captionRecent : props.captionAll,
            labels: props.labels.slice(-count),
            values: props.values.slice(-count),
          }),
        ],
      );
    };
  },
});

export default vueIsland(ThroughputChart);
