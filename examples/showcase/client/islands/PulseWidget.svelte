<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { IslandContext } from '@nestvexa/islands/client';
  import { createClientI18n, readLocaleHydration } from '@nestvexa/i18n/client';

  /*
   * Dashboard island (Svelte): local view state (counts or percentage) and
   * the member focused in the React chart, received through the islands
   * event bridge. Events are validated before use; the focus sentence is
   * formatted in the browser from the page's i18n hydration subset (the same
   * ICU plural rules as the server, Arabic included).
   */
  interface Props {
    readonly progressText: string;
    readonly percentText: string;
    readonly showPercentLabel: string;
    readonly showCountsLabel: string;
    readonly pickText: string;
    readonly done: number;
    readonly total: number;
    readonly island: IslandContext;
  }
  let {
    progressText,
    percentText,
    showPercentLabel,
    showCountsLabel,
    pickText,
    done,
    total,
    island,
  }: Props = $props();

  let percent = $state(false);
  let focus = $state(untrack(() => pickText));
  let hydrated = $state(false);
  const isFocus = (
    detail: unknown,
  ): detail is { readonly name: string; readonly open: number } =>
    typeof detail === 'object' &&
    detail !== null &&
    typeof Reflect.get(detail, 'name') === 'string' &&
    String(Reflect.get(detail, 'name')).length <= 60 &&
    Number.isSafeInteger(Reflect.get(detail, 'open'));

  onMount(() => {
    hydrated = true;
    const hydration = readLocaleHydration(document);
    const i18n = hydration ? createClientI18n(hydration) : undefined;
    return island.on(
      'member.focus',
      (detail) => {
        if (!isFocus(detail)) return;
        focus = i18n
          ? i18n.t('islands:pulse.focus', {
              name: detail.name,
              open: detail.open,
            })
          : `${detail.name}: ${detail.open}`;
      },
      isFocus,
    );
  });
</script>

<div class="pulse" data-hydrated={hydrated ? 'true' : 'false'}>
  <p id="pulse-progress">{percent ? percentText : progressText}</p>
  <progress
    id="pulse-meter"
    max={total || 1}
    value={done}
    aria-labelledby="pulse-progress"
  ></progress>
  <p>
    <button
      type="button"
      id="pulse-toggle"
      aria-pressed={percent ? 'true' : 'false'}
      onclick={() => (percent = !percent)}
    >
      {percent ? showCountsLabel : showPercentLabel}
    </button>
  </p>
  <p id="pulse-focus" role="status">{focus}</p>
</div>
