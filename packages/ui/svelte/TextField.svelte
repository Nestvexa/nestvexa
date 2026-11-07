<!--
  Labelled text-like input with hint and error wiring from the shared markup
  contract. `defaultValue` is read once; `onchange(value)` reports each edit.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { textFieldMarkup } from '@nestvexa/ui/markup';
  import type { FieldInputType, FieldViewLike } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  let {
    id = undefined,
    name,
    label,
    type = undefined,
    defaultValue = undefined,
    placeholder = undefined,
    autocomplete = undefined,
    minLength = undefined,
    maxLength = undefined,
    readOnly = false,
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
    type?: FieldInputType | undefined;
    defaultValue?: string | undefined;
    placeholder?: string | undefined;
    autocomplete?: string | undefined;
    minLength?: number | undefined;
    maxLength?: number | undefined;
    readOnly?: boolean;
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
  // Read once: the browser owns the value after mount.
  const initial = untrack(() => defaultValue);
  const tree = $derived(
    textFieldMarkup({
      id,
      name,
      label,
      type,
      value: initial,
      placeholder,
      autocomplete,
      minLength,
      maxLength,
      readOnly,
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
      if (target instanceof HTMLInputElement && target.value !== reported) {
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
