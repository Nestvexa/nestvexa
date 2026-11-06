<!-- APG menu button from the shared markup contract; `onselect(value)` for value items. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { connectUi, menuSelection } from '@nestvexa/ui/browser';
  import { menuMarkup } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  interface MenuItem {
    readonly label: string;
    readonly href?: string;
    readonly value?: string;
    readonly disabled?: boolean;
  }
  let {
    id,
    label,
    items,
    class: className = undefined,
    onselect = undefined,
  }: {
    id: string;
    label: string;
    items: readonly MenuItem[];
    class?: string | undefined;
    onselect?: ((value: string) => void) | undefined;
  } = $props();

  let element = $state<Element>();
  const tree = $derived(
    menuMarkup({
      id,
      label,
      class: className,
      items: items.map((item) => ({
        label: item.label,
        href: item.href,
        value: item.value,
        disabled: item.disabled,
      })),
    }),
  );
  onMount(() => {
    const root = element;
    if (!root) return;
    const release = connectUi(root);
    const selected = (event: Event) => {
      const value = menuSelection(event);
      if (value !== undefined) onselect?.(value);
    };
    root.addEventListener('nv-ui-menu-select', selected);
    return () => {
      root.removeEventListener('nv-ui-menu-select', selected);
      release();
    };
  });
</script>

<Markup node={tree} bind:element />
