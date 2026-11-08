# `nv:navigate`

Same-origin links marked with `nv:navigate` are visited by fetching the target
document and swapping `<body>` instead of reloading the page. Live components in
the old body are released and components in the new body are discovered and
mounted before Alpine initializes the new subtrees, so `$live` reads work on
swapped pages. With the default Alpine bootstrap (`startLiveAlpine` or
`adoptLiveAlpine`), Alpine trees in the old body are destroyed right before the
swap (`Alpine.destroyTree`), which releases their `$live.on` subscriptions.

```hbs
<a href='/projects?page=2' nv:navigate>Page 2</a>
<a href='/reports' nv:navigate.hover>Reports</a>
```

| Form                | Behavior                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `nv:navigate=""`    | Intercepts a primary click on the link                                                           |
| `nv:navigate.hover` | Also prefetches the document on pointer hover or keyboard focus (10 s lifetime, up to 8 entries) |

The value must be empty; other modifiers are rejected. Inside Live components the
directive must be on an `<a>` element.

## Prefetch

Prefetching is explicit (`nv:navigate.hover` only), same-origin and `GET`-only,
with the same headers as a visit. An entry lives 10 seconds and is used at most
once; the current page is never prefetched. Any committed Live request (an
action or `$sync`) clears every prefetched entry, because it may have changed
what those pages show. A visit that awaits a prefetched response and is then
superseded by a newer visit never applies that response.

## When it falls back to a full page load

The link behaves natively (no interception) for modified clicks (Ctrl, Meta,
Shift, Alt, middle button), `target` other than `_self`, `download` links,
cross-origin URLs and same-page fragment links.

After fetching, a normal full load is used instead of a swap when:

- the response is not a 2xx `text/html` response (for example a `404` page or
  a download), is larger than 2 MiB, or was redirected to another origin;
- the set of scripts, stylesheets and module preloads differs from the current
  document (a different asset version or page-specific script), or any inline
  script is present;
- the `<html lang>` or `dir` differs;
- the request fails.

A new visit falls back with `location.assign`; a Back/Forward revisit falls back
with `location.replace`, so the history stack keeps its length.

Server routes keep their normal guards: the swap uses an ordinary credentialed
`GET` with `Accept: text/html` and `X-Nestvexa-Navigate: 1`. Same-origin
redirects are followed and the final URL is shown. Fetch never exposes URL
fragments, so the clicked link's fragment carries over a redirect (as in a
browser navigation) while a fragment in the `Location` header is not
observable. Parsed documents never execute scripts; any script elements in the
incoming body are removed.

## History, scroll, focus, metadata and unsaved edits

Each visit pushes a history entry. While the client is mounted it owns
`history.scrollRestoration` (`manual`, restored on dispose): the scroll position
of every entry it leaves is remembered (up to 64 entries) and restored after the
swap on Back and on Forward. Revisits re-fetch the document through the host
route (old snapshots are never replayed). New visits scroll to the URL fragment
target or the top. A full reload of a swapped entry starts at the top.

Focus moves to `<main>` (or the first `<h1>`, then `<body>`), receiving
`tabindex="-1"` if needed, so screen readers announce the new page. The
document title follows the incoming document, and so do named and Open Graph
`<meta>` elements (`meta[name]` except `viewport`, and `meta[property]`):
missing ones are removed, new ones added. `aria-busy="true"` is set on `<html>`
while a visit is in progress (style it as a progress indicator), and
`nestvexa:navigate`/`nestvexa:navigated` window events fire around the swap.

If any Live component holds unsaved local edits, the browser asks for
confirmation ("Leave this page? Unsaved changes will be lost.") before a visit;
cancelling keeps the page and its drafts. Back/Forward cannot be cancelled and
does not ask. Server redirects from `redirectLive` use the same visit path.
Programmatic visits: `client.navigate(url)`.

Tests: [grammar](../../tests/client-optimistic-navigation.test.ts), the
pagination/Back scenarios in [projects.spec.ts](../../tests/browser/projects.spec.ts),
and the three-browser [navigation.spec.ts](../../tests/browser/navigation.spec.ts)
against the [browser-lab example](../../examples/browser-lab/README.md) (history,
scroll restoration, metadata, redirects, every fallback, prefetch reuse/expiry/
invalidation, dirty-draft confirmation and out-of-order visits).
