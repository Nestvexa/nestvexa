# Content Security Policy and security headers

Nestvexa does not install a CSP or any other security-header middleware. The
host owns response policy. This page shows policies that match how each mode
loads code, and which of them the repository exercises in browsers.

## HBS and Live pages

The umbrella serves the **Alpine CSP build** (`@alpinejs/csp` 3.17.5). The
Live client evaluates no expressions: `nv:` directives use a closed, data-only
grammar. `{{nvScripts}}` emits one external module tag pointing at the
version-neutral boot route. The browser code is therefore all same-origin
external modules, and no `'unsafe-eval'` or `'unsafe-inline'` script source
is needed.

The starter and counter examples send this policy on every page that mounts
Live components:

<!-- snippet: examples/starter-live/src/main.ts -->

```ts
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  )
```

The browser suites run the Live examples under this header. Their pages use
same-origin stylesheets only. Realtime SSE and polling are same-origin requests
covered by `default-src 'self'`. The `/realtime` page in the starter also sets
`connect-src 'self'` explicitly.

### Nonces with `nvScripts`

For a nonce-based policy, generate a fresh base64 or base64url nonce per
request on the server and pass it to the layout:

```hbs
{{nvScripts nonce=cspNonce}}
```

The helper validates the value against base64/base64url syntax and rejects
anything else. Never derive the nonce from request input.
`NestvexaBrowserService.scripts(nonce)` does the same in code. A nonce is
required when the policy uses `'strict-dynamic'`, because browsers then ignore
`'self'` for scripts. Modules imported by the boot script are trusted
transitively.

### Alpine and host code

The Alpine CSP build never uses `eval` or `new Function`, so it supports only
a restricted subset of inline expressions. Move non-trivial logic into
components registered with `Alpine.data()` before startup. In automatic mode, listen for `nestvexa:alpine:init`. In manual mode,
register them in your own boot module. See
[default Live setup](../guides/default-live-setup.md#document-scripts) and the
[Alpine CSP documentation](https://alpinejs.dev/advanced/csp).

## Vite and Inertia pages

`@nestvexa/vite` ships `cspNonceMiddleware()` and `cspNonce(request)`. The
middleware generates a 128-bit nonce per request (`bytes` 16–64) and sets the
header (`reportOnly: true` sends `Content-Security-Policy-Report-Only`). Its
default directives are:

<!-- snippet: packages/vite/src/csp.ts -->

```ts
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
```

`assets.tags(app, { nonce })` adds the nonce to the entry script, preloads and
a `<meta property="csp-nonce">`. Vite's preload helper and Inertia's progress
bar use that meta for the elements they insert later. Pass
`nonce: (request) => cspNonce(request)` to `InertiaModule.forRoot`. The shared
React/Vue/Svelte browser suite (`tests/browser/inertia-framework-suite.ts`)
records `securitypolicyviolation` events under this policy and asserts that
there are none. See the [Vite guide](../guides/vite.md#tags-preloads-and-csp).

In development with a separate Vite server (`devOrigin`), the policy must also
allow that origin and `ws:` for HMR. Middleware mode, the documented setup,
keeps a single origin.

## Islands

The hybrid example sends:

<!-- snippet: examples/hybrid-dashboard/src/main.ts -->

```ts
const csp =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
```

It needs `'unsafe-inline'` for styles because the example compiles Svelte
with `css: 'injected'`, which inserts `<style>` elements at runtime. If you
emit component CSS as a stylesheet instead, you can drop `'unsafe-inline'`.
That variant is not exercised by the example. The island bundles themselves
are same-origin modules and need no extra script source.

## Uploads and downloads

Files served through the uploads download helper carry their own headers,
whatever your page policy is: `Content-Security-Policy: default-src 'none';
sandbox`, `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy:
same-origin`, private `no-store` caching and an `attachment` disposition, unless
a raster image asks for `inline`. Do not serve stored files through a generic
static middleware.

## Other security headers

These are standard recommendations. The examples set only `Cache-Control`
and `Content-Security-Policy` per route.

| Header                            | Recommendation                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `Strict-Transport-Security`       | Set at the TLS-terminating proxy once HTTPS is permanent                         |
| `X-Content-Type-Options: nosniff` | Nestvexa already sends it on assets, realtime and uploads; add it globally       |
| `Referrer-Policy`                 | `strict-origin-when-cross-origin` or stricter                                    |
| `frame-ancestors 'none'` (CSP)    | Replaces `X-Frame-Options` in modern browsers; keep both if you support old ones |
| `Cross-Origin-Opener-Policy`      | `same-origin` unless you rely on cross-origin popups                             |
| `Cache-Control: no-store`         | Required on every page that mounts Live components or embeds private data        |

With [helmet](https://helmetjs.github.io/), a third-party package that
Nestvexa neither depends on nor tests, turn off its CSP when you set CSP per
route or through `cspNonceMiddleware`, so that two policies do not combine:

```ts
import helmet from 'helmet';

app.use(helmet({ contentSecurityPolicy: false })); // CSP is set elsewhere
app.use(cspNonceMiddleware()); // Vite/Inertia hosts only
```

When a response carries several CSP headers, browsers enforce all of them. A
second, looser policy therefore cannot relax the first, but a stricter one can
break pages.

## Asset CDNs

- **Live/Alpine assets** are served by the application under
  `/_nestvexa/assets/<sha256>/…` with immutable caching. `basePath` accepts
  path prefixes only, not URLs. A CDN can cache these responses if it sits in
  front of the same origin. Serving them from a separate asset origin is not
  supported. No SRI helper exists: content hashes identify versions but do not
  provide integrity attributes.
- **Vite assets** support an absolute CDN `base` (for example
  `https://cdn.example.com/app/`) plus a `crossOrigin` attribute. This is
  covered by manifest unit tests. Add the CDN origin to `script-src` (or rely
  on `'strict-dynamic'` with nonces) and to `style-src`.
- Keep HTML and the Live boot script uncached at the CDN.

> **Known gap:** No CDN deployment, SRI generation, compression of client
> assets or CSP reporting endpoint has been built or tested by this project.
> CSP behavior in the browser suites covers the policies shown above on a
> single origin. See [hardening](../security/hardening.md) and the
> [threat model](../security/threat-model.md).
