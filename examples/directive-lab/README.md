# Directive lab

Run `pnpm build`, then `pnpm --filter @nestvexa/example-directive-lab start`. Visit `http://127.0.0.1:3360` (set `PORT` to change it).

One real Nest/Express Live component combines directives and modifiers under a strict policy: `script-src 'self'`, `style-src 'self'`, no `unsafe-eval` and enforced Trusted Types (`require-trusted-types-for 'script'; trusted-types nestvexa`). The page shows:

- `nv:click` with `.once`, `.debounce.150ms`, `.ctrl` and an `nv:optimistic.increment` projection;
- a global `nv:keydown.window.escape` hotkey declared on a hidden element;
- a slow action with `nv:loading.attr="disabled"` plus a `nv:loading.delay.150ms` status, and a quick action whose delayed indicator never flashes;
- `nv:submit` with native `required`/`type=email` validation, a deferred `nv:model`, `nv:dirty` and a targeted submit `disabled` effect;
- `nv:model.live.debounce.100ms` with a `$sync` loading target, and `nv:model.blur.number`;
- `nv:confirm` through the native dialog, `nv:show` with a CSS leave transition, `nv:bind="aria-expanded:open"` and a polite live region updated in place;
- nested model paths (`address.city`, `address.zip`) checked by a server allowlist that keeps `address.verified` server-owned, a checkbox group over `topics` validated by count and allowlist, an idempotent `deposit` action retried safely after dropped requests and lost replies, and an `nv:sort` list reordered by keyboard and pointer;
- an action that throws, demonstrating suspension without a false `nv:offline` hint;
- `nv:navigate` to `/about` and back without reloading the client.

The [browser scenarios](../../tests/browser/directive-lab.spec.ts) run against this server in Chromium, Firefox and WebKit, including an axe scan and a `securitypolicyviolation` listener that must stay empty. A server validator rejecting the synchronized search draft is recoverable; an exception thrown by an action is not, and the client suspends transport until reload. See the [directive matrix](../../docs/reference/directive-matrix.md) and the [CSP guide](../../docs/guides/csp.md).

The anonymous memory session is a demonstration identity only; production needs a persistent session store, HTTPS cookies, authenticated principals and policy review.
