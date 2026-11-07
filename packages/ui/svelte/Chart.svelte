<!--
  Server-rendered SVG chart (or a `type="custom"` container whose `children`
  mount a third-party chart) plus its data table, from the shared markup
  contract.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { chartMarkup } from '@nestvexa/ui/markup';
  import type { ChartType } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  let {
    id,
    type = undefined,
    title,
    description = undefined,
    categoryLabel,
    labels,
    series,
    min = undefined,
    max = undefined,
    locale = undefined,
    showTable = false,
    class: className = undefined,
    children = undefined,
  }: {
    id: string;
    type?: ChartType | undefined;
    title: string;
    description?: string | undefined;
    categoryLabel: string;
    labels: readonly string[];
    series: readonly {
      readonly name: string;
      readonly values: readonly number[];
    }[];
    min?: number | undefined;
    max?: number | undefined;
    locale?: string | undefined;
    showTable?: boolean;
    class?: string | undefined;
    children?: Snippet | undefined;
  } = $props();

  const tree = $derived(
    chartMarkup({
      id,
      type,
      title,
      description,
      categoryLabel,
      labels: [...labels],
      series: series.map((entry) => ({
        name: entry.name,
        values: [...entry.values],
      })),
      min,
      max,
      locale,
      showTable,
      class: className,
    }),
  );
</script>

{#snippet content(_slot: string)}{@render children?.()}{/snippet}

<Markup node={tree} {content} />
