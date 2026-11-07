<!--
  Radio group in a <fieldset role="radiogroup"> with legend, hint and error
  from the shared markup contract. `defaultValue` is read once;
  `onchange(value)` reports the chosen value.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { radioGroupFieldMarkup } from '@nestvexa/ui/markup';
  import type { FieldViewLike } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  let {
    id = undefined,
    name,
    label,
    options,
    defaultValue = undefined,
    hint = undefined,
    error = undefined,
    field = undefined,
    required = false,
    disabled = false,
    describedBy = undefined,
    class: className = undefined,
    onchange = undefined,
  }: {
    id?: string | undefined;
    name: string;
    label: string;
    options: readonly {
      readonly value: string;
      readonly label: string;
      readonly disabled?: boolean;
    }[];
    defaultValue?: string | undefined;
    hint?: string | undefined;
    error?: string | readonly string[] | undefined;
    field?: FieldViewLike | undefined;
    required?: boolean;
    disabled?: boolean;
    describedBy?: string | undefined;
    class?: string | undefined;
    onchange?: ((value: string) => void) | undefined;
  } = $props();

  let element = $state<Element>();
  // Read once: the browser owns the selection after mount.
  const initial = untrack(() => defaultValue);
  const tree = $derived(
    radioGroupFieldMarkup({
      id,
      name,
      label,
      options: options.map((option) => ({
        value: option.value,
        label: option.label,
        disabled: option.disabled,
      })),
      value: initial,
      hint,
      error,
      field,
      required,
      disabled,
      describedBy,
      class: className,
    }),
  );
  onMount(() => {
    const root = element;
    if (!root) return;
    let reported = initial ?? '';
    const changed = (event: Event) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement &&
        target.type === 'radio' &&
        target.checked &&
        target.value !== reported
      ) {
        reported = target.value;
        onchange?.(target.value);
      }
    };
    root.addEventListener('input', changed);
    root.addEventListener('change', changed);
    return () => {
      root.removeEventListener('input', changed);
      root.removeEventListener('change', changed);
    };
  });
</script>

<Markup node={tree} bind:element />
