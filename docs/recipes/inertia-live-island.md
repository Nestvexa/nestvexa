# A Live element inside an Inertia page

**Goal:** a React page rendered through Inertia hosts a server-driven Live
component (here a counter). React state and Live state never reset each other,
and Inertia partial reloads leave the Live component alone.

Example: `/react/live` in [examples/inertia-mixed](../../examples/inertia-mixed/README.md)
(port 3109).

## 1. Pass the Live mount as a lazy prop

The controller mounts the registered component and returns its HTML as a lazy
prop, so `router.reload({ only: ['stamp'] })` neither re-mounts nor replaces it:

<!-- snippet: examples/inertia-mixed/src/main.ts -->

```ts
  @Get('react/live')
  @Header('Cache-Control', 'no-store')
  @InertiaPage('LiveHost')
  reactLive(@Req() request: SessionRequest) {
    request.session.csrf ??= randomBytes(32).toString('base64url');
    return {
      ...pageProps('react', 'live host'),
      live: async () => (await this.live.mount(MixedCounter, request)).value,
      stamp: () => Date.now(),
    };
  }
```

## 2. Give the Live client its own DOM subtree

React owns an empty host `<div>`; `createLiveClient({ root })` from
`@nestvexa/client` owns everything inside it and is disposed in the effect
cleanup:

<!-- snippet: examples/inertia-mixed/client/react/pages/LiveHost.tsx -->

```tsx
element.innerHTML = html;
const client = createLiveClient({
  root: element,
  onError: (error) => {
    element.dataset['liveError'] = error.message;
  },
});
client.mount();
element.dataset['liveMounted'] = 'true';
return () => {
  // Inertia navigation away (or a new mount from the server) disposes the
  // client first: listeners are removed and in-flight requests aborted.
  client.dispose();
  delete element.dataset['liveMounted'];
  element.replaceChildren();
};
```

React renders no children into the host, so reconciliation never touches Live
markup, and the Live client is scoped to the host, so its morphs and listeners
never reach React's DOM.

## Security notes

- The `live` prop is trusted server output of a registered component, the only
  HTML that may go through `innerHTML` here. Never pass user-controlled HTML.
- Live actions are ordinary Live POSTs with the Origin, CSRF and `authorize`
  checks; they are never Inertia visits.
- Do not also load the document-wide `boot.js` on that page; two clients would
  claim the same markers.

## Tests

- [tests/browser/inertia-mixed.spec.ts](../../tests/browser/inertia-mixed.spec.ts)
  ("an Inertia React page hosts an isolated Live element across Inertia visits"):
  Live actions are Live requests, React state survives Live morphs and the
  reverse, a partial reload keeps the same Live DOM node, and leaving and
  returning through Inertia remounts cleanly with no CSP violations or page
  errors.

> **Known gap:** Live and Inertia do not share one client-side navigation; the
> Live element is remounted after each Inertia visit to the page.

See also: [coexistence guide](../guides/coexistence.md#a-live-element-inside-an-inertia-page),
[Inertia guide](../guides/inertia.md) and [islands](../guides/islands.md) for the
reverse direction (framework components inside HBS/Live pages).
