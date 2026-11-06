<!--
  Toast live region from the shared markup contract. Call `show(message,
  options)` on the instance (`bind:this`). `messages` are read once.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { connectUi, showToast } from '@nestvexa/ui/browser';
  import type { ToastOptions } from '@nestvexa/ui/browser';
  import { toastRegionMarkup } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';

  let {
    id,
    label,
    dismissLabel,
    messages = undefined,
    event = undefined,
  }: {
    id: string;
    label: string;
    dismissLabel: string;
    messages?: readonly string[] | undefined;
    event?: string | undefined;
  } = $props();

  let element = $state<Element>();
  // Initial messages only: later toasts are appended by the module.
  const initial = untrack(() => (messages ? [...messages] : undefined));
  const tree = $derived(
    toastRegionMarkup({ id, label, dismissLabel, event, messages: initial }),
  );
  onMount(() => (element ? connectUi(element) : undefined));

  /** Append a text-only toast; errors use the assertive list. */
  export function show(
    message: string,
    options?: ToastOptions,
  ): HTMLElement | undefined {
    return element ? showToast(element, message, options) : undefined;
  }
</script>

<Markup node={tree} bind:element />
