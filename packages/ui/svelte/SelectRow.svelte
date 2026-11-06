<!-- <td> with a named row checkbox posted by native forms. -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { connectUi } from '@nestvexa/ui/browser';
  import { selectRowMarkup } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  let {
    name,
    value,
    label,
    defaultChecked = false,
  }: {
    name: string;
    value: string;
    label: string;
    defaultChecked?: boolean;
  } = $props();

  let element = $state<Element>();
  const tree = $derived(
    selectRowMarkup({ name, value, label, checked: defaultChecked }),
  );
  onMount(() => (element ? connectUi(element) : undefined));
</script>

<Markup node={tree} bind:element />
