# ADR 0006: Trusted templates, untrusted view data

Status: accepted for the MVC foundation; amended 2026-11-07 (mutation endpoints, below).

Application templates/helpers execute with application privileges and require code review. View data is untrusted; normal interpolation must escape it. Trusted HTML branding represents explicit application trust, not sanitization. Browser-selected filesystem paths are disallowed and resolved template files must remain under the configured real root, including symlinks.

Rejected: accepting arbitrary absolute template filenames, treating signed browser data as secret, or promising CSRF based on a boolean option. The current release contains no mutation endpoint. Hosts must protect their own routes; future Live endpoints must fail closed without verified CSRF and identity context.

Failure modes include raw triple-brace use, unsafe custom helpers, HTML-context confusion and symlink swaps by a filesystem attacker. Templates must be deployed read-only from trusted sources. [Security tests](../../tests/security.test.ts) and [engine tests](../../tests/views.test.ts) cover implemented boundaries. Independent security review and the full ASVS mapping remain unmet release gates.

## Trade-offs and cost

- Trusting templates and helpers keeps the engines fast and simple: no sandbox,
  no runtime policy on helper code. The cost is that template and helper review
  is a security review, and a raw triple-brace or an unsafe helper is an
  application vulnerability the framework cannot detect at runtime.
- Treating all view data as untrusted means escaping by default in every
  first-party engine. Trusted HTML must be marked explicitly with `SafeHtml`,
  which adds some call-site ceremony.
- Resolving template paths against the real root costs a `realpath` per
  uncached lookup, and the root must be readable by the process.
- Fail-closed mutation endpoints need the host to supply identity and a CSRF
  token. There is no built-in session or login, so every host writes a
  `resolveIdentity` function.

## Failure modes

- Raw output (`{{{ }}}`, `SafeHtml.trusted` on user input) or a custom helper
  that returns unescaped HTML: cross-site scripting. Escaping also does not
  validate URL schemes or CSS contexts ([hardening](../security/hardening.md)).
- A filesystem attacker swaps a symlink under the template root. Resolution
  re-checks the real path, but writable template directories stay unsafe;
  deploy them read-only.
- A host disables CSRF (`csrf.required: false`) for cookie-based auth, or
  returns identity from request-body claims. Both are host misconfigurations
  that the framework cannot detect.
- A host authorizes too broadly in `authorize`. The framework calls it for each
  component, action, `$mount`, `$sync` and job request, but cannot judge the
  policy.

## Amendment (2026-11-07): mutation endpoints exist

The sentence "the current release contains no mutation endpoint" is no longer
true. The rule it anticipated holds: every mutation endpoint fails closed
without verified identity, an exact `Origin` and a CSRF token.

- Live actions and `_sync` check origin, CSRF, identity, ownership, rate,
  payload and revision before component code runs (`tests/live-security.test.ts`).
- Server actions run admission (POST only, exact `Origin`, JSON content type,
  constant-time CSRF comparison, rate limit, body shape and prototype-key
  checks) before group and method guards (`tests/actions-security.test.ts`,
  `tests/actions-http.test.ts`).
- Upload routes need the host identity, the `x-nestvexa-csrf` header and the
  exact `Origin`. The multipart fallback requires the CSRF field before any file
  part (`tests/uploads-http.test.ts`).
- Progressive forms verify CSRF before handling a submission
  (`tests/forms-progressive.test.ts`).
- The Inertia adapter, i18n, the client runtime and mail have their own
  negative suites (`tests/inertia-security.test.ts`, `tests/i18n-security.test.ts`,
  `tests/client-security.test.ts`, `tests/mail-security.test.ts`).

An [internal review](../security/internal-review-2026-11.md) was recorded in
November 2026. It is not independent. The independent security review and a
claimed ASVS level remain unmet release gates
([ASVS traceability](../security/asvs-traceability.md)).
