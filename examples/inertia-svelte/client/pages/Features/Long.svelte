<script lang="ts">
  import { Link } from '@inertiajs/svelte';
  import type { FeaturePages } from '../../../src/page-types';

  // Scroll management by the official client: visits reset the window and
  // every `scroll-region` element to the top, `preserveScroll` keeps the
  // position, back/forward restores both from the history entry, and a
  // `#hash` scrolls to its anchor.
  let { page, next }: FeaturePages['Features/Long'] = $props();
  // The client looks up `[scroll-region]`; Svelte's element types do not list
  // the attribute, so it is spread in.
  const scrollRegion: Record<string, string> = { 'scroll-region': '' };
</script>

<svelte:head>
  <title>Long page {page} · Nestvexa Svelte</title>
</svelte:head>

<h1>Long page {page}</h1>
<div
  {...scrollRegion}
  class="scroll-region"
  data-testid="region"
  role="region"
  aria-label="Scroll region"
>
  <div class="scroll-region-content">Region content</div>
</div>
<div class="long-spacer" aria-hidden="true"></div>
<h2 id="anchor">Anchor on page {page}</h2>
<div class="long-spacer" aria-hidden="true"></div>
<nav aria-label="Long pages" class="stack">
  <Link href={`/features/long/${next}`}>Next long page</Link>
  <Link href={`/features/long/${next}`} preserveScroll>
    Next, preserving scroll
  </Link>
  <Link href={`/features/long/${next}#anchor`}>Next, to the anchor</Link>
  <Link href="/features/tour">Back to features</Link>
</nav>
