# Strict CSP and Trusted Types

The Live client runs under a strict Content Security Policy without `unsafe-eval` or `unsafe-inline`, and under enforced Trusted Types. It never evaluates directive strings: every `nv:*` value is parsed by a closed grammar into identifiers, literals or class tokens.

## Recommended policy

```text
default-src 'self';
script-src 'self';
style-src 'self';
object-src 'none';
base-uri 'none';
frame-ancestors 'none';
form-action 'self';
require-trusted-types-for 'script';
trusted-types nestvexa
```

- Serve the client and your boot module as files (for example through `nestvexa/assets`); do not inline the boot script.
- Put `[nv\:cloak]{display:none}` and transition classes in a stylesheet. Avoid `style="…"` attributes in Live templates: a strict `style-src` blocks them, and the client never writes inline styles.
- If you use Alpine, load the Alpine CSP build (`entries.alpine` in the asset manifest).

## Trusted Types

The client has exactly two HTML sinks: the `<template>` used to parse a Live response fragment and the `DOMParser` used by `nv:navigate`. Both receive their markup through one module-private policy named `nestvexa` (`trustedTypes.createPolicy('nestvexa', …)`), created lazily on first use. List it in `trusted-types`. The policy passes the application's own server-rendered HTML through unchanged; the parsed result still goes through the client's fragment/document validation (no active document tags, inline event handlers or foreign namespaces in updates). The policy object is never exposed, so other scripts cannot use it to create TrustedHTML.

If the page policy does not allow `nestvexa`, policy creation fails, the sink throws, and the client reports the update as failed (the component suspends) instead of falling back to an untrusted string. Browsers without Trusted Types use plain strings.

Pages that load two copies of the client must allow `'allow-duplicates'` or deduplicate the bundle; the second copy otherwise fails closed.

## Verification

- [client-csp.test.ts](../../tests/client-csp.test.ts): a real HTTP Live endpoint under the policy above; clicks, model synchronization, cloak removal, escaped text and `nv:navigate` produce no `securitypolicyviolation`; a policy without `nestvexa` fails closed; the public bundle contains no `eval`, `new Function`, string timers, `outerHTML`/`insertAdjacentHTML` or `document.write`.
- [directive-lab.spec.ts](../../tests/browser/directive-lab.spec.ts): the same policy on a real Nest server in Chromium, Firefox and WebKit with an empty violation log.

CSP is a response header owned by the host application; Nestvexa does not install it.
