# Focus after Live updates

Live captures the current focused element and supported input selection immediately before applying a response. A retained, available control keeps focus and selection where its resulting input type supports the selection API. If it becomes disabled (including through a fieldset), hidden, inert or unrendered, or is removed, the client attempts to focus its available component root with `preventScroll`.

This fallback keeps keyboard navigation near the updated content. It does not focus a hidden or inert root, reveal hidden content or enable a disabled control. Focus handling follows the browser's actual focus result, rather than assuming `focus()` succeeds. The [HTML focus processing model](https://html.spec.whatwg.org/multipage/interaction.html#focus) defines the native behavior; the root fallback is Nestvexa policy layered over it.

When the root has no `tabindex`, this reconciliation fallback temporarily adds `tabindex="-1"`. It removes that attribute and its blur listener on blur, component release, subtree removal or client disposal. Existing root tabindex values remain host-owned. A host change from the temporary `-1` to another value is preserved. An identical host write of `-1` is indistinguishable from the framework's temporary value; use a declared root focus policy when that value must persist.

User focus changes while a request is pending are respected: focus is sampled at response application, not action dispatch. Synchronous removal hooks or focus handlers can also choose a different connected target. Restoration does not override that target or restore the old control's selection there. Moving focus explicitly to the document body cannot be distinguished reliably from native focus loss and may use the root fallback.

The starter demonstrates server actions that disable or hide a focused unbound input. Run `pnpm --filter @nestvexa/example-starter-live start` after building, then open `http://127.0.0.1:3102`. Its [browser scenarios](../../tests/browser/focus.spec.ts) use held real server responses across the configured browsers. [Controlled lifecycle tests](../../tests/client-rendering-lifecycle.test.ts) cover fieldsets, CSS visibility/display, inert controls, hidden input types, host hooks and cleanup. Controlled responses prove client behavior, not server protocol conformance.

## Visibility and loading ownership

The same client-owned controller now handles fallback focus for `nv:show`, `nv:dirty`, loading visibility and post-morph restoration. Client disposal, component release, owner removal/reparenting outside the fallback relationship, and blur release framework-owned temporary focusability. A host-written different tabindex value is preserved. If hiding the component root, bindings attempt to focus its available parent; they do not force focus into a hidden/inert parent.

Two sibling roots or clients using the same installed focus module can share a parent fallback. Their temporary tabindex ownership is leased: releasing one owner keeps the attribute while another owner still needs it. Native blur releases the temporary attribute and listener for all leases. This is browser presentation ownership, not shared application state or server authorization. Independently duplicated module copies do not coordinate these leases; use one installed client runtime per document.

Loading restores its presentation baselines when a request settles, but does not move focus back into the previously hidden control. The temporary fallback remains until blur or owner cleanup. The low-level binding helper's implicit controller retains only blur cleanup; hosts calling that internal helper directly must pass an explicit controller for owner/disposal cleanup. Normal `createLiveClient` supplies one and renews it on explicit client remount.

See [visibility/loading browser scenarios](../../tests/browser/visibility-focus.spec.ts) and [controller tests](../../tests/client-focus.test.ts). The installed asset catalog now contains 14 client modules plus the Alpine adapter and CSP build (16 assets). A custom host that maintains its own file allowlist must include `focus.js`; the standard asset module handles it automatically.

Contenteditable selection, cross-owner native radio groups, shadow DOM, focus inside iframes, arbitrary widget portals, complete nested renderer lifecycles and manual screen-reader acceptance remain unsupported or unverified. This is not WCAG certification. Client focus never authorizes an action or validates server input.
