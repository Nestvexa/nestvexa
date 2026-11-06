<!-- Side-anchored modal dialog: <Dialog drawer>. -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import Dialog from './Dialog.svelte';

  let {
    children = undefined,
    ...rest
  }: {
    id: string;
    title: string;
    closeLabel: string;
    describedBy?: string | undefined;
    closeOn?: string | undefined;
    class?: string | undefined;
    side?: 'start' | 'end' | undefined;
    children?: Snippet | undefined;
    onclose?: (() => void) | undefined;
  } = $props();
</script>

<Dialog {...rest} drawer={true} {children} />
