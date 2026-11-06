export class LiveClientError extends Error {
  constructor(
    readonly code:
      | 'DIRECTIVE'
      | 'MARKER'
      | 'RESPONSE'
      | 'HTTP'
      | 'HTML'
      | 'NETWORK'
      | 'TIMEOUT'
      | 'ABORTED',
    message: string,
  ) {
    super(message);
    this.name = 'LiveClientError';
  }
}
const forbidden = new Set(['constructor', '__proto__', 'prototype']);
export function parseIdentifier(value: string): string {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value) || forbidden.has(value))
    throw new LiveClientError(
      'DIRECTIVE',
      'Expected a registered identifier, without expressions or paths',
    );
  return value;
}

interface HtmlPolicy {
  createHTML(input: string): unknown;
}
const policies = new WeakMap<object, HtmlPolicy | null>();
/**
 * Route same-origin server HTML through one module-private Trusted Types
 * policy named `nestvexa`. Pages enforcing `require-trusted-types-for 'script'`
 * allow it with `trusted-types nestvexa`. The markup is rendered by the
 * application server and still passes the closed fragment/document validation
 * after parsing; the policy object is never exposed to other scripts.
 */
export function trustedHTML(view: object, html: string): string {
  let policy = policies.get(view);
  if (policy === undefined) {
    policy = null;
    const factory: unknown = Reflect.get(view, 'trustedTypes');
    try {
      if (factory && typeof factory === 'object')
        policy = (
          factory as {
            createPolicy(
              name: string,
              rules: { createHTML(input: string): string },
            ): HtmlPolicy;
          }
        ).createPolicy('nestvexa', { createHTML: (input) => input });
    } catch {
      // A page policy excluding `nestvexa` keeps the plain string: the sink then
      // throws and the caller reports a rejected update instead of bypassing CSP.
    }
    policies.set(view, policy);
  }
  // DOM HTML sinks accept TrustedHTML wherever their TypeScript type says string.
  return (policy ? policy.createHTML(html) : html) as string;
}
