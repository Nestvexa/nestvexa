import { defineComponent, h, onMounted, onUnmounted, ref } from 'vue';
import type { PropType } from 'vue';
import { vueIsland } from '@nestvexa/islands/vue';
import { createActionComposables } from './generated/actions-client.vue.js';
import type { DashboardIsland } from './services.js';
import { track } from './track.js';

/** Server-rendered and hydrated Vue island using a generated composable. */
export const ActivityFeed = defineComponent({
  props: {
    items: { type: Array as PropType<string[]>, required: true },
    island: { type: Object as PropType<DashboardIsland>, required: true },
  },
  setup(props) {
    const entries = ref([...props.items]);
    const draft = ref('');
    const record = createActionComposables(
      props.island.services.actions,
    ).useDashboardRecordEvent();
    onMounted(() => {
      track('activity-feed', 'mount');
      props.island.on(
        'chart.selected',
        (detail) => {
          const value = Reflect.get(detail as object, 'index');
          if (typeof value === 'number')
            entries.value = [
              `Chart quarter ${value + 1} selected`,
              ...entries.value,
            ].slice(0, 10);
        },
        // Payload validation: only well-formed selection events are accepted.
        (detail) =>
          typeof detail === 'object' &&
          detail !== null &&
          typeof Reflect.get(detail, 'index') === 'number',
      );
    });
    onUnmounted(() => track('activity-feed', 'unmount'));
    return () => {
      const state = record.state.value;
      const issue = state.error?.issues[0];
      return h('div', { class: 'feed' }, [
        h('label', { for: 'feed-draft' }, 'Local note'),
        h('input', {
          id: 'feed-draft',
          value: draft.value,
          'aria-invalid': issue?.path[0] === 'label' ? 'true' : undefined,
          onInput: (event: Event) => {
            draft.value = (event.target as HTMLInputElement).value;
          },
        }),
        h(
          'button',
          {
            type: 'button',
            onClick: () => {
              const note = draft.value.trim();
              if (note) entries.value = [note, ...entries.value].slice(0, 10);
              draft.value = '';
              void record.run({ kind: 'note.added', label: note });
            },
          },
          'Add note',
        ),
        h(
          'p',
          { id: 'feed-total' },
          issue
            ? issue.message
            : state.data
              ? `${state.data.total} events recorded`
              : 'Not saved yet',
        ),
        h(
          'ul',
          { id: 'feed-items' },
          entries.value.map((entry, index) =>
            h('li', { key: `${index}-${entry}` }, entry),
          ),
        ),
      ]);
    };
  },
});
export default vueIsland(ActivityFeed);
