<!--
  APG tabs from the shared markup contract. `panel` renders each panel:
  {#snippet panel(tab)}…{/snippet} receives the tab item.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { Snippet } from 'svelte';
  import { connectUi } from '@nestvexa/ui/browser';
  import { tabPanelSlot, tabsMarkup } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  interface TabItem {
    readonly id: string;
    readonly label: string;
    readonly selected?: boolean;
  }
  let {
    id,
    label,
    tabs,
    panel,
  }: {
    id: string;
    label: string;
    tabs: readonly TabItem[];
    panel: Snippet<[TabItem]>;
  } = $props();

  let element = $state<Element>();
  const tree = $derived(
    tabsMarkup({
      id,
      label,
      tabs: tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        selected: tab.selected,
      })),
    }),
  );
  onMount(() => (element ? connectUi(element) : undefined));
</script>

{#snippet content(slot: string)}{#each tabs as tab (tab.id)}{#if tabPanelSlot(tab.id) === slot}{@render panel(tab)}{/if}{/each}{/snippet}

<Markup node={tree} {content} bind:element />
