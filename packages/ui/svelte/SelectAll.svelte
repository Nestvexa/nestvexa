<!-- <th> with a select-all checkbox (mixed state managed by the module). -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { connectUi } from '@nestvexa/ui/browser';
  import { selectAllMarkup } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  let { table, label }: { table: string; label: string } = $props();

  let element = $state<Element>();
  const tree = $derived(selectAllMarkup({ table, label }));
  onMount(() => (element ? connectUi(element) : undefined));
</script>

<Markup node={tree} bind:element />
