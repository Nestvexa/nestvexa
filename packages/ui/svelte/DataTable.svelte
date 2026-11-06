<!-- Captioned table with a filter/selection status line; `children` is <thead>/<tbody>. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import { connectUi } from '@nestvexa/ui/browser';
  import { dataTableMarkup } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  let {
    id,
    caption,
    selectionLabel = undefined,
    class: className = undefined,
    children = undefined,
  }: {
    id: string;
    caption: string;
    selectionLabel?: string | undefined;
    class?: string | undefined;
    children?: Snippet | undefined;
  } = $props();

  let element = $state<Element>();
  const tree = $derived(
    dataTableMarkup({ id, caption, selectionLabel, class: className }),
  );
  onMount(() => (element ? connectUi(element) : undefined));
</script>

{#snippet content(_slot: string)}{@render children?.()}{/snippet}

<Markup node={tree} {content} bind:element />
