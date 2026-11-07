import { computed, defineComponent, h, onMounted, ref } from 'vue';
import type { PropType } from 'vue';
import type { IslandContext } from '@nestvexa/islands/client';
import { vueIsland } from '@nestvexa/islands/vue';
import { BarChart } from '../shared/bar-chart.js';

/**
 * Dashboard island: server-rendered (SSR) and hydrated. The range toggle is
 * local framework state; Live re-renders of the metrics panel next to it never
 * touch it (islands are separate ownership boundaries).
 */
export const ThroughputChart = defineComponent({
  props: {
    title: { type: String, required: true },
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
    const count = computed(() =>
      recent.value ? Math.min(4, props.values.length) : props.values.length,
    );
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
        value ? 'Last 4 weeks' : 'All weeks',
      );
    return () =>
      h(
        'div',
        {
          class: 'island-chart',
          'data-hydrated': hydrated.value ? 'true' : 'false',
        },
        [
          h('p', { role: 'group', 'aria-label': 'Chart range' }, [
            toggle(false),
            ' ',
            toggle(true),
          ]),
          h(BarChart, {
            idPrefix: 'dashboard-chart',
            caption: `${props.title} (${count.value} weeks)`,
            labels: props.labels.slice(-count.value),
            values: props.values.slice(-count.value),
          }),
        ],
      );
  },
});

export default vueIsland(ThroughputChart);
