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
