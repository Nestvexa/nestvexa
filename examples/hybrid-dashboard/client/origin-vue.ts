import { defineComponent, h } from 'vue';
import { vueIsland } from '@nestvexa/islands/vue';

/** Deliberate hydration mismatch (diagnostics page): text differs per side. */
export const OriginVue = defineComponent({
  props: { island: { type: Object, required: true } },
  setup() {
    return () =>
      h(
        'p',
        { class: 'origin' },
        `Rendered in ${typeof window === 'undefined' ? 'server' : 'browser'}`,
      );
  },
});
export default vueIsland(OriginVue);
