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
      | 'ABORTED'
      | 'PROTOCOL',
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
/** A field or a dotted path of at most 8 identifier segments (`address.city`); no indices or expressions. */
export function parsePath(value: string): string {
  const parts = value.split('.');
  if (parts.length > 8) parseIdentifier('.');
  for (const part of parts) parseIdentifier(part);
  return value;
}
/** Resolve own data along a path of plain objects; anything else is undefined. */
export function readPath(values: unknown, path: string): unknown {
  let value = values;
  for (const key of path.split('.'))
    value =
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.getOwnPropertyDescriptor(value, key)?.value
        : undefined;
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
