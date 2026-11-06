<!-- Button (or same-origin fallback link) that opens the dialog `target`. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { connectUi } from '@nestvexa/ui/browser';
  import { dialogTriggerMarkup } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  let {
    target,
    label,
    href = undefined,
    class: className = undefined,
  }: {
    target: string;
    label: string;
    href?: string | undefined;
    class?: string | undefined;
  } = $props();

  let element = $state<Element>();
  const tree = $derived(
    dialogTriggerMarkup({ target, label, href, class: className }),
  );
  onMount(() => (element ? connectUi(element) : undefined));
</script>

<Markup node={tree} bind:element />
