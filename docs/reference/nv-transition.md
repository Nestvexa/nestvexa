# `nv:transition`

Use static CSS classes for finite enter and leave transitions inside Live-owned markup. Applications provide the CSS; directive values contain class names, never JavaScript or inline styles.

```hbs
<div
  nv:show='expanded'
  nv:transition.enter='panel-motion'
  nv:transition.enter-start='panel-transparent'
  nv:transition.enter-end='panel-opaque'
  nv:transition.leave='panel-motion'
  nv:transition.leave-start='panel-opaque'
  nv:transition.leave-end='panel-transparent'
>
  Panel content
</div>
```

```css
.panel-motion {
  transition: opacity 150ms ease;
}
.panel-transparent {
  opacity: 0;
}
.panel-opaque {
  opacity: 1;
}
```

Supported declarations are exactly `nv:transition.enter`, `.enter-start`, `.enter-end`, `.leave`, `.leave-start`, and `.leave-end`. Each value is 1–16 unique class tokens matching `[A-Za-z_][A-Za-z0-9_-]{0,63}`. Bare `nv:transition`, expression values, duration modifiers and CSS animation/keyframe lifecycle management are unsupported and rejected.

The phase class and start classes are applied first. Two animation frames allow the browser to commit start styles, then start classes are removed and end classes are applied. The runtime waits for the finite computed CSS transition duration plus delay, with a bounded completion margin, then restores the affected class tokens. Durations exceeding five seconds are rejected. The timer is a bounded fallback even when a CSS property does not change and no completion event fires. A native `transitioncancel` event cancels the phase. See the [CSS Transitions event contract](https://drafts.csswg.org/css-transitions/#transition-events).

The first `nv:show`/dirty visibility projection is immediate. Later changes use the enter phase after revealing content, or the leave phase before setting `hidden`. While leaving, `aria-hidden="true"` applies immediately after moving focus to a safe component fallback. Repeated projections of the same desired visibility do not restart the transition. Reversing visibility cancels the old phase; a stale leave cannot hide a subsequently revealed element. Cleanup, ownership loss or disposal cancels deferred hiding and restores temporary classes/ARIA effects.

With [reduced motion requested](https://drafts.csswg.org/mediaqueries-5/#prefers-reduced-motion), new phases complete immediately without temporary classes. Enabling reduced motion during a visibility leave stops motion and commits its requested visibility immediately. Native animation settings do not disable content or actions.

Runtime integrations may call `enter(node)` or `leave(node)`, receiving `Promise<boolean>` (`false` means cancellation, invalid ownership or rejected configuration). These functions do not remove or hide the node. `show(element, shown, apply)` integrates with the binding owner's synchronous `apply()` callback and handles reversal/deduplication. Applications that need animated removal must explicitly await a successful leave before removing the same still-owned node. The synchronous DOM morph removal hook does not delay removal for exit motion; removed nodes are cleaned up immediately. An enter phase can be run for newly inserted owned elements.

Nested Live roots, whole `nv:ignore` subtrees and framework islands retain their own lifecycles. Transition class tokens cannot overlap class tokens controlled by loading/offline/current effects. Host CSS should avoid making focused content unavailable independently of the visibility integration. No claim is made for teleport portals or arbitrary third-party animation ownership.

Verification: [real Chromium presentation tests](../../tests/client-presentation.test.ts) exercise finite CSS motion, class restoration, reduced motion, visibility reversal, disposal, ownership loss and bounded-duration rejection. These tests verify the controller; application-specific CSS and renderer integrations require their own browser checks.
