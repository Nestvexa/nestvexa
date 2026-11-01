# `nv:navigate`

Same-origin links marked with `nv:navigate` are visited by fetching the target
document and swapping `<body>` instead of reloading the page. Live components in
the old body are released and components in the new body are discovered and
mounted; Alpine initializes new subtrees through its own observer.

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

## When it falls back to a full page load

The link behaves natively (no interception) for modified clicks (Ctrl, Meta,
Shift, Alt, middle button), `target` other than `_self`, `download` links,
cross-origin URLs and same-page fragment links.

After fetching, a normal `location.assign` is used instead of a swap when:

- the response is not a 2xx `text/html` response, is larger than 2 MiB, or was
  redirected to another origin;
- the set of scripts, stylesheets and module preloads differs from the current
  document (a different asset version or page-specific script), or any inline
  script is present;
- the `<html lang>` or `dir` differs;
- the request fails.

Server routes keep their normal guards: the swap uses an ordinary credentialed
`GET` with `Accept: text/html` and `X-Nestvexa-Navigate: 1`. Parsed documents
never execute scripts; any script elements in the incoming body are removed.

## History, scroll, focus and unsaved edits

Each visit pushes a history entry; the scroll position of the page being left is
stored in its entry and restored on Back/Forward, which re-fetch the document
through the host route (old snapshots are never replayed). New visits scroll to
the URL fragment target or the top. Focus moves to `<main>` (or the first `<h1>`,
then `<body>`), receiving `tabindex="-1"` if needed, so screen readers announce
the new page. The document title and `meta[name=description]` are updated.
`aria-busy="true"` is set on `<html>` while a visit is in progress, and
`nestvexa:navigate`/`nestvexa:navigated` window events fire around the swap.

If any Live component holds unsaved local edits, the browser asks for
confirmation before leaving. Server redirects from `redirectLive` use the same
visit path. Programmatic visits: `client.navigate(url)`.

Tests: [grammar](../../tests/client-optimistic-navigation.test.ts) and the
pagination/Back scenarios in [projects.spec.ts](../../tests/browser/projects.spec.ts).
