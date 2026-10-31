# `nv:current`

Apply static route-active classes to a same-origin HTML anchor inside a Live component.

```hbs
<a href='/products' nv:current='active'>Products and descendants</a>
<a href='/products' nv:current.exact='active'>Only products</a>
```

`nv:current` matches the target pathname and nested path segments. `/products` matches `/products/42`, but not `/products-archive`. `nv:current.exact` matches only the target pathname. Trailing slashes are normalized; query strings and fragments do not participate. `/` matches only the root even in nested mode. Percent-encoded paths retain the browser URL parser's representation; the directive does not decode them into extra path segments.

The value is 1–16 unique CSS class tokens matching `[A-Za-z_][A-Za-z0-9_-]{0,63}`. It is never an expression. The anchor must have a nonempty `href`, without whitespace/control characters, using the document's HTTP(S) origin and no embedded credentials. External links, executable schemes and non-anchor targets are rejected. URL resolution uses the [standard URL parser](https://url.spec.whatwg.org/#url-class) against the current document URL; an HTML `base` element does not change this directive's matching base.

The runtime refreshes registered components on `popstate` and after component binding refresh. Host code using `history.pushState()` or `replaceState()` directly must refresh bindings or dispatch its documented navigation event; those methods do not emit `popstate` themselves. This directive does not intercept navigation, fetch pages or provide authorization.

Classes return to their captured baseline when the route stops matching or ownership ends. An active class already present in server markup belongs to that baseline and is retained. Prefer a neutral server baseline if the class should be entirely client-controlled. Later host writes are respected during cleanup. The directive does not automatically write `aria-current`; applications can render appropriate accessible navigation semantics server-side.

Parent Live components skip nested Live roots, framework islands and whole `nv:ignore` subtrees. A transition or loading declaration cannot control the same class token. Cleanup restores owned class effects without touching other classes.

Verification: [parser and real Chromium route tests](../../tests/client-presentation.test.ts) cover exact/nested boundaries, history refresh, query/hash behavior, safe URLs and reversible cleanup. Cross-framework page navigation continues to use the application's full-document boundary rules.
