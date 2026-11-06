<!--
  Native date input plus a locale-formatted <output> from the shared markup
  contract. `defaultValue` is read once; `onchange(value)` reports changes.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { connectUi } from '@nestvexa/ui/browser';
  import { datePickerMarkup } from '@nestvexa/ui/markup';
  import type { DateStyle } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  let {
    id,
    name,
    label,
    defaultValue = undefined,
    min = undefined,
    max = undefined,
    locale = undefined,
    dateStyle = undefined,
    required = false,
    describedBy = undefined,
    onchange = undefined,
  }: {
    id: string;
    name: string;
    label: string;
    defaultValue?: string | undefined;
    min?: string | undefined;
    max?: string | undefined;
    locale?: string | undefined;
    dateStyle?: DateStyle | undefined;
    required?: boolean;
    describedBy?: string | undefined;
    onchange?: ((value: string) => void) | undefined;
  } = $props();

  let element = $state<Element>();
  // Read once: the module owns the input value after mount.
  const initial = untrack(() => defaultValue);
  const tree = $derived(
    datePickerMarkup({
      id,
      name,
      label,
      value: initial,
      min,
      max,
      locale,
      dateStyle,
      required,
      describedBy,
    }),
  );
  onMount(() => {
    const root = element;
    if (!root) return;
    const release = connectUi(root);
    const changed = (event: Event) => {
      const target = event.target;
      if (target instanceof HTMLInputElement && target.type === 'date')
        onchange?.(target.value);
    };
    root.addEventListener('change', changed);
    return () => {
      root.removeEventListener('change', changed);
      release();
    };
  });
</script>

<Markup node={tree} bind:element />
