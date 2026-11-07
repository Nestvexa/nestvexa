# Browser runtime lab

A small Nest application for the Live browser runtime's cross-page behavior:
`nv:navigate` (history, scroll restoration, metadata, prefetch, dirty-draft
confirmation and every full-page fallback), the Alpine `$live` helpers with the
real CSP Alpine 3.17 build, out-of-order replies, tab visibility and network
loss, the progressive full-page fallback of a suspended component, and
listener/timer/observer release across many mounted components.

It uses the default setup: one HBS layout, `{{nvScripts}}` (the generated boot
module that starts the bundled CSP Alpine and mounts the Live client) and a
strict CSP without `unsafe-eval` or inline scripts.

```sh
pnpm --filter @nestvexa/example-browser-lab... build
PORT=3860 pnpm --filter @nestvexa/example-browser-lab start
```

| Route                    | Purpose                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `/`                      | Counter with a deferred `nv:model` draft, a live-synced `echo` field and a no-JS `POST /note` form |
| `/long`                  | Tall page with a `#section-b` fragment and a `robots` meta tag                                     |
| `/prefetch`              | Target of the `nv:navigate.hover` link; shows its per-session render number                        |
| `/alpine`                | `$live.state`, `$live.dispatch`, `$live.on` and `$live.entangle` against an `@OnEvent` component   |
| `/ticker`                | `nv:poll.1s` and an `nv:offline` banner                                                            |
| `/many?count=N`          | N (1–40) components, each with a poll timer, an intersection observer and an Alpine subtree        |
| `/assets-differ`, `/rtl` | Different asset identity or document direction: navigation falls back to a full load               |
| `/plain.txt`, `/missing` | Non-HTML and 404 responses: full load                                                              |
| `/to-long`               | Same-origin redirect to `/long`                                                                    |
| `/api/served`            | Per-session render counts, used by the tests to tell swaps, prefetch reuse and reloads apart       |

Callbacks for `$live.on` are registered in `/lab-alpine.js` with `Alpine.data`
on the `nestvexa:alpine:init` event, because the CSP build cannot evaluate
arrow functions in templates.

The lab raises `maxRequestsPerMinute` and the memory store capacity because the
leak checks mount hundreds of components per minute in one session. The
`POST /note` route checks the request `Origin`; a production host also needs
real authentication, CSRF protection for host forms, a persistent session store
and HTTPS cookies.

Tests (Chromium, Firefox and WebKit, port 3860):
[navigation](../../tests/browser/navigation.spec.ts),
[Alpine bridge](../../tests/browser/alpine-bridge.spec.ts),
[runtime resilience](../../tests/browser/runtime-resilience.spec.ts) and
[lifecycle leaks](../../tests/browser/lifecycle-leaks.spec.ts).
