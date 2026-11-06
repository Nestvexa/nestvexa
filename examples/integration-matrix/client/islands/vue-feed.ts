import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue';
import type { PropType } from 'vue';
import type { IslandContext } from '@nestvexa/islands/client';
import { vueIsland } from '@nestvexa/islands/vue';
import { track } from './track.js';

const ActivityFeed = defineComponent({
  props: {
    items: { type: Array as PropType<string[]>, required: true },
    island: { type: Object as PropType<IslandContext>, required: true },
  },
  setup(props) {
    const entries = ref([...props.items]);
    const draft = ref('');
    onMounted(() => {
      track('activity-feed', 'mount');
      props.island.on('chart.selected', (detail) => {
        const value =
          detail && typeof detail === 'object'
            ? Reflect.get(detail, 'index')
            : undefined;
        if (typeof value === 'number')
          entries.value = [
            `Chart quarter ${value + 1} selected`,
            ...entries.value,
          ].slice(0, 10);
      });
    });
    onUnmounted(() => track('activity-feed', 'unmount'));
    return () =>
      h('div', { class: 'feed' }, [
        h('label', { for: 'feed-draft' }, 'Local note'),
        h('input', {
          id: 'feed-draft',
          value: draft.value,
          onInput: (event: Event) => {
            draft.value = (event.target as HTMLInputElement).value;
          },
        }),
        h(
          'button',
          {
            type: 'button',
            onClick: () => {
              if (draft.value.trim())
                entries.value = [draft.value.trim(), ...entries.value].slice(
                  0,
                  10,
                );
              draft.value = '';
            },
          },
          'Add note',
        ),
        h(
          'ul',
          { id: 'feed-items' },
          entries.value.map((entry, index) =>
            h('li', { key: `${index}-${entry}` }, entry),
          ),
        ),
      ]);
  },
});
export default vueIsland(ActivityFeed);
