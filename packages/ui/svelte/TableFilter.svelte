<!-- Native <select> table filter matching rows by `data-{field}`. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { connectUi } from '@nestvexa/ui/browser';
  import { tableFilterMarkup } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  let {
    table,
    field,
    label,
    allLabel,
    options,
    id = undefined,
    name = undefined,
    client = false,
    resultsLabel = undefined,
    defaultValue = undefined,
  }: {
    table: string;
    field: string;
    label: string;
    allLabel: string;
    options: readonly { readonly value: string; readonly label: string }[];
    id?: string | undefined;
    name?: string | undefined;
    client?: boolean;
    resultsLabel?: string | undefined;
    defaultValue?: string | undefined;
  } = $props();

  let element = $state<Element>();
  const tree = $derived(
    tableFilterMarkup({
      table,
      key: field,
      label,
      allLabel,
      options: options.map((option) => ({
        value: option.value,
        label: option.label,
      })),
      id,
      name,
      client,
      resultsLabel,
      value: defaultValue,
    }),
  );
  onMount(() => (element ? connectUi(element) : undefined));
</script>

<Markup node={tree} bind:element />
