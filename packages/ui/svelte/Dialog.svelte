<!-- Modal <dialog> from the shared markup contract; `children` is the body. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import { connectUi } from '@nestvexa/ui/browser';
  import { dialogMarkup } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  let {
    id,
    title,
    closeLabel,
    describedBy = undefined,
    closeOn = undefined,
    class: className = undefined,
    drawer = false,
    side = undefined,
    children = undefined,
    onclose = undefined,
  }: {
    id: string;
    title: string;
    closeLabel: string;
    describedBy?: string | undefined;
    closeOn?: string | undefined;
    class?: string | undefined;
    drawer?: boolean;
    side?: 'start' | 'end' | undefined;
    children?: Snippet | undefined;
    onclose?: (() => void) | undefined;
  } = $props();

  let element = $state<Element>();
  const tree = $derived(
    dialogMarkup({
      id,
      title,
      closeLabel,
      describedBy,
      closeOn,
      class: className,
      drawer,
      side,
    }),
  );
  onMount(() => {
    const root = element;
    if (!root) return;
    const release = connectUi(root);
    const closed = () => onclose?.();
    root.addEventListener('close', closed);
    return () => {
      root.removeEventListener('close', closed);
      release();
    };
  });
</script>

{#snippet content(_slot: string)}{@render children?.()}{/snippet}

<Markup node={tree} {content} bind:element />
