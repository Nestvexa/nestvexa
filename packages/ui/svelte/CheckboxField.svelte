<!--
  Single checkbox with its label, hint and error from the shared markup
  contract. `defaultChecked` is read once; `onchange(checked)` reports changes.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { checkboxFieldMarkup } from '@nestvexa/ui/markup';
  import type { FieldViewLike } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  let {
    id = undefined,
    name,
    label,
    value = undefined,
    defaultChecked = false,
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
    value?: string | undefined;
    defaultChecked?: boolean;
    hint?: string | undefined;
    error?: string | readonly string[] | undefined;
    field?: FieldViewLike | undefined;
    required?: boolean;
    disabled?: boolean;
    describedBy?: string | undefined;
    class?: string | undefined;
    onchange?: ((checked: boolean) => void) | undefined;
  } = $props();

  let element = $state<Element>();
  // Read once: the browser owns the checked state after mount.
  const initial = untrack(() => defaultChecked);
  const tree = $derived(
    checkboxFieldMarkup({
      id,
      name,
      label,
      value,
      checked: initial,
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
    let reported = initial;
    const changed = (event: Event) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement &&
        target.type === 'checkbox' &&
        target.checked !== reported
      ) {
        reported = target.checked;
        onchange?.(target.checked);
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
