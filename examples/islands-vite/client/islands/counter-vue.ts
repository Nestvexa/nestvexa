import { defineComponent, h, ref } from 'vue';
import type { PropType } from 'vue';
import type { IslandContext } from '@nestvexa/islands/client';
import { vueIsland } from '@nestvexa/islands/vue';

/** Vue island (render function, no SFC compiler needed): SSR + hydration. */
export const CounterVue = defineComponent({
  props: {
    label: { type: String, required: true },
    start: { type: Number, required: true },
    // Declared so the loader's context is not rendered as a fallthrough attribute.
    island: { type: Object as PropType<IslandContext>, required: true },
  },
  setup(props) {
    const count = ref(props.start);
    return () =>
      h('div', { class: 'counter', 'data-framework': 'vue' }, [
        h('p', { id: 'vue-count' }, `${props.label}: ${count.value}`),
        h(
          'button',
          { type: 'button', onClick: () => (count.value += 1) },
          'Increment Vue',
        ),
      ]);
  },
});

export default vueIsland(CounterVue);
