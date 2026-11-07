<!--
  Renders one node of the @nestvexa/ui markup contract. Text is escaped by
  Svelte; slots are rendered by the caller's `content` snippet, which receives
  the slot name. The root element is bindable so a
  wrapper can connect it to the keyboard module. SVG subtrees (charts) are
  rendered by SvgMarkup.svelte in the SVG namespace; a textarea's text is
  set as its value, since Svelte would print hydration markers inside it.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import {
    booleanAttributes,
    isMarkupSlot,
    voidElements,
  } from '@nestvexa/ui/markup';
  import type { MarkupElement, MarkupNode } from '@nestvexa/ui/markup';
  import Markup from './Markup.svelte';
  import SvgMarkup from './SvgMarkup.svelte';

  let {
    node,
    content = undefined,
    element = $bindable(),
  }: {
    node: MarkupNode;
    content?: Snippet<[string]> | undefined;
    element?: Element | undefined;
  } = $props();

  function attributes(tree: MarkupElement): Record<string, string | true> {
    const output: Record<string, string | true> = {};
    for (const [name, value] of Object.entries(tree.attributes)) {
      // Live directives only appear when a Live-only option is passed.
      if (name.startsWith('nv:')) continue;
      output[name] = booleanAttributes.has(name)
        ? true
        : value === true
          ? ''
          : value;
    }
    return output;
  }
  /** A textarea's initial text, set as its value rather than as children. */
  function text(tree: MarkupElement): string {
    return tree.children
      .filter((child): child is string => typeof child === 'string')
      .join('');
  }
</script>

{#if typeof node === 'string'}{node}{:else if isMarkupSlot(node)}{@render content?.(node.slot)}{:else if node.tag === 'textarea'}<textarea bind:this={element} {...attributes(node)} value={text(node)}></textarea>{:else if node.tag === 'svg'}<svelte:element this="svg" bind:this={element} {...attributes(node)}>{#each node.children as child, index (index)}<SvgMarkup node={child} />{/each}</svelte:element>{:else if voidElements.has(node.tag)}<svelte:element this={node.tag} bind:this={element} {...attributes(node)} />{:else}<svelte:element this={node.tag} bind:this={element} {...attributes(node)}>{#each node.children as child, index (index)}<Markup node={child} {content} />{/each}</svelte:element>{/if}
