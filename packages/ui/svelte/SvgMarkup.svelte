<!--
  Renders the children of an <svg> from the @nestvexa/ui markup contract.
  Compiled in the SVG namespace, so elements created on the client (a mount
  rather than hydration) are SVG elements, not unknown HTML elements.
-->
<svelte:options namespace="svg" />

<script lang="ts">
  import type { MarkupNode } from '@nestvexa/ui/markup';
  import { isMarkupSlot } from '@nestvexa/ui/markup';
  import SvgMarkup from './SvgMarkup.svelte';

  let { node }: { node: MarkupNode } = $props();
</script>

{#if typeof node === 'string'}{node}{:else if !isMarkupSlot(node)}<svelte:element this={node.tag} {...node.attributes}>{#each node.children as child, index (index)}<SvgMarkup node={child} />{/each}</svelte:element>{/if}
