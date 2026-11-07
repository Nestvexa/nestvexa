/**
 * Scheme allowlist for links built from page props. Vue and Svelte escape text
 * and attribute values but do not filter URL schemes, so a `javascript:` or
 * `data:` value bound to `href` would run when clicked. The URL parser strips
 * the same whitespace and tabs the browser does before reading the scheme.
 */
export function safeHref(value: string): string {
  try {
    const { protocol } = new URL(value, 'https://relative.invalid');
    return protocol === 'https:' || protocol === 'http:' ? value : '#';
  } catch {
    return '#';
  }
}
