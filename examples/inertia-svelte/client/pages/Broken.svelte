<script lang="ts">
  import type { BrokenProps } from '../../src/page-types';

  let { reason }: BrokenProps = $props();

  function fail(message: string): string {
    throw new Error(message);
  }
</script>

<!-- Throws while rendering: the layout's svelte:boundary takes over. -->
<h1>{fail(reason)}</h1>
