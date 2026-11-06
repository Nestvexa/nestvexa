<!-- Labelled search box for a table (client filtering with `client`). -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { connectUi } from '@nestvexa/ui/browser';
  import { tableSearchMarkup } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  let {
    table,
    label,
    id = undefined,
    name = undefined,
    client = false,
    resultsLabel = undefined,
    defaultValue = undefined,
    placeholder = undefined,
  }: {
    table: string;
    label: string;
    id?: string | undefined;
    name?: string | undefined;
    client?: boolean;
    resultsLabel?: string | undefined;
    defaultValue?: string | undefined;
    placeholder?: string | undefined;
  } = $props();

  let element = $state<Element>();
  const tree = $derived(
    tableSearchMarkup({
      table,
      label,
      id,
      name,
      client,
      resultsLabel,
      value: defaultValue,
      placeholder,
    }),
  );
  onMount(() => (element ? connectUi(element) : undefined));
</script>

<Markup node={tree} bind:element />
