<!-- <th> with aria-sort and a same-origin sort link. -->
<script lang="ts">
  import { sortHeaderMarkup } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  let {
    label,
    sortKey,
    sort = undefined,
    direction = undefined,
    href,
  }: {
    label: string;
    sortKey: string;
    sort?: string | undefined;
    direction?: 'asc' | 'desc' | undefined;
    href: string;
  } = $props();

  const tree = $derived(
    sortHeaderMarkup({ label, key: sortKey, sort, direction, href }),
  );
</script>

<Markup node={tree} />
